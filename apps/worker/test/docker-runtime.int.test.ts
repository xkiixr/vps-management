import { randomBytes } from 'node:crypto'
import { DEFAULT_DEPLOY_CONFIG, type DeployConfig } from '@vpsm/core'
import Dockerode from 'dockerode'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { buildContainerSpec } from '../src/runtime/container-spec'
import { createDockerRuntime } from '../src/runtime/docker-runtime'

// Needs a Docker daemon (dockerode honours DOCKER_HOST) and pulls alpine:3; run with INTEGRATION=1.
// Everything this file creates is named `vpsm-int-<run id>...` and is removed in afterAll.
const IMAGE = 'alpine:3'
const run = `vpsm-int-${randomBytes(3).toString('hex')}`
const names = {
  main: `${run}-main`,
  unmanaged: `${run}-unmanaged`,
  dies: `${run}-dies`,
  base: `${run}-base`,
  fromCommit: `${run}-from-commit`,
  net1: `${run}-net1`,
  net2: `${run}-net2`,
}
const committedImage = { repo: `vpsm-int/${run}`, tag: '1' }
const committedRef = `${committedImage.repo}:${committedImage.tag}`
// Exits promptly on SIGTERM (plain `sleep` as PID 1 would ignore it).
const LONG_RUNNING = ['sh', '-c', 'trap "exit 0" TERM; sleep 60 & wait']
const NEVER_RESTART: DeployConfig = { ...DEFAULT_DEPLOY_CONFIG, restartPolicy: 'never' }

const docker = new Dockerode()
const runtime = createDockerRuntime(docker)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const specFor = (name: string, networkName: string, cmd: string[], deploy: DeployConfig = DEFAULT_DEPLOY_CONFIG) =>
  buildContainerSpec({
    name,
    image: IMAGE,
    env: { PORT: '8080', GREETING: 'hello world' },
    deploy,
    cmd,
    networkName,
    aliases: ['web.internal'],
    deploymentId: 'd-int',
    serviceInstanceId: 'si-int',
  })

async function waitFor<T>(what: string, poll: () => Promise<T | undefined> | T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await poll()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

beforeAll(async () => {
  if (await runtime.imageExists(IMAGE)) return
  const stream = await docker.pull(IMAGE)
  await new Promise<void>((resolve, reject) => docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())))
}, 120_000)

afterAll(async () => {
  const containers = await docker.listContainers({ all: true, filters: { name: [run] } })
  for (const c of containers) await runtime.stopAndRemove(c.Id, 1)
  const networks = await docker.listNetworks({ filters: { name: [run] } })
  for (const n of networks) await docker.getNetwork(n.Id).remove()
  await runtime.removeImage(committedRef)
}, 60_000)

test('run, state, listManaged, restart, stopAndRemove round trip', async () => {
  await runtime.ensureNetwork(names.net1)
  await runtime.run(specFor(names.main, names.net1, LONG_RUNNING))

  const state = await runtime.state(names.main)
  expect(state).toMatchObject({ exists: true, running: true, restarting: false, restartCount: 0, restartPolicy: 'on-failure', maxRetries: 10 })

  // The hardening from the spec is really applied by the daemon.
  const info = await docker.getContainer(names.main).inspect()
  expect(info.HostConfig).toMatchObject({
    Memory: 512 * 1024 * 1024,
    MemorySwap: 512 * 1024 * 1024,
    NanoCpus: 1e9,
    PidsLimit: 512,
    Privileged: false,
    SecurityOpt: ['no-new-privileges:true'],
  })
  expect(info.HostConfig.Binds ?? []).toEqual([])
  expect(info.Config.Env).toEqual(expect.arrayContaining(['GREETING=hello world', 'PORT=8080']))
  expect(info.NetworkSettings.Networks[names.net1].Aliases).toContain('web.internal')

  expect(await runtime.listManaged()).toContainEqual({
    name: names.main,
    deploymentId: 'd-int',
    serviceInstanceId: 'si-int',
    memoryMb: 512,
    running: true,
  })

  // A second container with the same name is refused, not replaced.
  await expect(runtime.run(specFor(names.main, names.net1, LONG_RUNNING))).rejects.toThrow(`container ${names.main} already exists`)
  expect((await runtime.state(names.main)).running).toBe(true)

  const startedBefore = info.State.StartedAt
  await runtime.restart(names.main)
  const after = await docker.getContainer(names.main).inspect()
  expect(after.State.Running).toBe(true)
  expect(after.State.StartedAt).not.toBe(startedBefore)

  await runtime.stopAndRemove(names.main, 5)
  expect((await runtime.state(names.main)).exists).toBe(false)
  expect((await runtime.listManaged()).map((c) => c.name)).not.toContain(names.main)
  // Nothing left to remove: still no error.
  await expect(runtime.stopAndRemove(names.main, 1)).resolves.toBeUndefined()
  expect(await runtime.state(names.main)).toEqual({
    exists: false,
    running: false,
    restarting: false,
    exitCode: 0,
    restartCount: 0,
    restartPolicy: '',
    maxRetries: 0,
  })
}, 60_000)

test('ensureNetwork and connect are idempotent', async () => {
  await runtime.ensureNetwork(names.net1)
  await runtime.ensureNetwork(names.net1)
  await runtime.ensureNetwork(names.net2)
  await runtime.ensureNetwork(names.net2)

  await runtime.run(specFor(names.main, names.net1, LONG_RUNNING))
  await runtime.connect(names.main, names.net2)
  await runtime.connect(names.main, names.net2)
  await runtime.connect(names.main, names.net1) // already attached at creation

  const { NetworkSettings } = await docker.getContainer(names.main).inspect()
  expect(Object.keys(NetworkSettings.Networks).sort()).toEqual([names.net1, names.net2])
  await runtime.stopAndRemove(names.main, 5)
})

test('onContainerDie reports managed containers only, and stops after unsubscribe', async () => {
  await runtime.ensureNetwork(names.net1)
  const died: string[] = []
  const errors: Error[] = []
  const unsubscribe = runtime.onContainerDie((name) => died.push(name), (err) => errors.push(err))
  try {
    await sleep(500) // let the event stream open

    // An unmanaged container (no vpsm.managed label) that dies must be ignored.
    const unmanaged = await docker.createContainer({ name: names.unmanaged, Image: IMAGE, Cmd: ['sh', '-c', 'exit 0'] })
    await unmanaged.start()
    await unmanaged.wait()

    await runtime.run(specFor(names.dies, names.net1, ['sh', '-c', 'exit 3'], NEVER_RESTART))
    await waitFor('die event', () => (died.includes(names.dies) ? true : undefined))
    expect(died).toEqual([names.dies])
    expect((await runtime.state(names.dies)).exitCode).toBe(3)
    expect((await runtime.state(names.dies)).running).toBe(false)

    unsubscribe()
    await runtime.stopAndRemove(names.dies, 1)
    await runtime.run(specFor(names.dies, names.net1, ['sh', '-c', 'exit 4'], NEVER_RESTART))
    await waitFor('second exit', async () => ((await runtime.state(names.dies)).running ? undefined : true))
    await sleep(300)
    expect(died).toEqual([names.dies]) // the second death was not reported
    expect(errors).toEqual([])
  } finally {
    unsubscribe()
  }
}, 60_000)

test('imageExists and removeImage', async () => {
  expect(await runtime.imageExists(IMAGE)).toBe(true)
  expect(await runtime.imageExists(`vpsm-int/${run}-missing:1`)).toBe(false)
  await expect(runtime.removeImage(`vpsm-int/${run}-missing:1`)).resolves.toBeUndefined()

  // An image with a single tag that a (stopped) container still uses cannot be removed: silent no-op.
  const base = await docker.createContainer({ name: names.base, Image: IMAGE, Cmd: ['true'] })
  await base.commit({ repo: committedImage.repo, tag: committedImage.tag })
  await docker.createContainer({ name: names.fromCommit, Image: committedRef, Cmd: ['true'] })
  expect(await runtime.imageExists(committedRef)).toBe(true)
  await expect(runtime.removeImage(committedRef)).resolves.toBeUndefined()
  expect(await runtime.imageExists(committedRef)).toBe(true)

  await runtime.stopAndRemove(names.fromCommit, 1)
  await runtime.removeImage(committedRef)
  expect(await runtime.imageExists(committedRef)).toBe(false)
}, 60_000)
