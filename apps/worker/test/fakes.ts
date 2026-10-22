import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type Dockerode from 'dockerode'
import type { Db } from '@vpsm/db'
import { loadConfig } from '../src/config'
import type { PipelineDeps } from '../src/deploy/pipeline'
import { DEPLOYMENT_LABEL, INSTANCE_LABEL, MEMORY_LABEL } from '../src/runtime/container-spec'
import type { ContainerState, DockerRuntime, ManagedContainer } from '../src/runtime/docker-runtime'

type FakeContainer = Omit<ManagedContainer, 'running'> & { spec?: Dockerode.ContainerCreateOptions; state: ContainerState }

const runningState = (): ContainerState => ({
  exists: true,
  running: true,
  restarting: false,
  exitCode: 0,
  restartCount: 0,
  restartPolicy: 'on-failure',
  maxRetries: 10,
})

const MISSING: ContainerState = {
  exists: false,
  running: false,
  restarting: false,
  exitCode: 0,
  restartCount: 0,
  restartPolicy: '',
  maxRetries: 0,
}

/**
 * An in-memory Docker. `run`, `attachAlias`, `stopAndRemove` and `restart` are recorded in `events` as
 * `run <name>`, `alias <name> <aliases joined by ,>`, `stop <name>` and `restart <name>`.
 */
export class FakeDocker implements DockerRuntime {
  readonly existingImages = new Set<string>()
  readonly networks = new Set<string>()
  /** `[container, network]` for every `connect` call. */
  readonly connections: [string, string][] = []
  private readonly containers = new Map<string, FakeContainer>()
  /** Per container: the networks it is on, each with its aliases there. */
  private readonly endpoints = new Map<string, Map<string, string[]>>()
  private readonly specs: Dockerode.ContainerCreateOptions[] = []
  /** One entry per `onContainerDie` subscription (the same callback may subscribe more than once). */
  private readonly dieSubscriptions = new Set<{ cb: (name: string) => void; onError?: (err: Error) => void }>()
  private seeded = 0

  constructor(readonly events: string[] = []) {}

  has(name: string): boolean {
    return this.containers.has(name)
  }

  /** The container's aliases on `network`, or undefined when it is not on that network. */
  aliasesOf(name: string, network: string): string[] | undefined {
    return this.endpoints.get(name)?.get(network)
  }

  private joinNetwork(name: string, network: string, aliases: string[]): void {
    const networks = this.endpoints.get(name) ?? new Map<string, string[]>()
    networks.set(network, [...aliases])
    this.endpoints.set(name, networks)
  }

  lastSpec(): Dockerode.ContainerCreateOptions {
    const spec = this.specs.at(-1)
    if (!spec) throw new Error('no container was run')
    return spec
  }

  /** Adds running managed containers without recording events (e.g. other services, or the live one). */
  seedRunning(list: { memoryMb: number; name?: string; deploymentId?: string; serviceInstanceId?: string }[]): void {
    for (const c of list) {
      const name = c.name ?? `vpsm-seed-${this.seeded++}`
      this.containers.set(name, {
        name,
        deploymentId: c.deploymentId ?? '',
        serviceInstanceId: c.serviceInstanceId ?? '',
        memoryMb: c.memoryMb,
        state: runningState(),
      })
    }
  }

  setState(name: string, partial: Partial<ContainerState>): void {
    const container = this.containers.get(name)
    if (!container) throw new Error(`no container ${name}`)
    container.state = { ...container.state, ...partial }
  }

  emitDie(name: string): void {
    for (const { cb } of [...this.dieSubscriptions]) cb(name)
  }

  /** Breaks the event stream of every current `onContainerDie` subscription, like a daemon restart. */
  failEventStream(err: Error): void {
    for (const { onError } of [...this.dieSubscriptions]) onError?.(err)
  }

  /** How many `onContainerDie` subscriptions are open. */
  get dieSubscribers(): number {
    return this.dieSubscriptions.size
  }

  async ensureNetwork(name: string): Promise<void> {
    this.networks.add(name)
  }

  async connect(containerName: string, networkName: string): Promise<void> {
    if (!this.networks.has(networkName)) throw new Error(`no network ${networkName}`)
    this.connections.push([containerName, networkName])
    this.joinNetwork(containerName, networkName, this.aliasesOf(containerName, networkName) ?? [])
  }

  async attachAlias(containerName: string, networkName: string, aliases: string[]): Promise<void> {
    if (!this.networks.has(networkName)) throw new Error(`no network ${networkName}`)
    if (!this.containers.has(containerName)) throw new Error(`no container ${containerName}`)
    this.events.push(`alias ${containerName} ${aliases.join(',')}`)
    this.joinNetwork(containerName, networkName, aliases)
  }

  async run(spec: Dockerode.ContainerCreateOptions): Promise<void> {
    const name = spec.name
    if (!name) throw new Error('fake docker needs a container name')
    if (this.containers.has(name)) throw new Error(`container ${name} already exists`)
    this.events.push(`run ${name}`)
    this.specs.push(spec)
    if (spec.Image) this.existingImages.add(spec.Image)
    const labels = spec.Labels ?? {}
    this.containers.set(name, {
      name,
      deploymentId: labels[DEPLOYMENT_LABEL] ?? '',
      serviceInstanceId: labels[INSTANCE_LABEL] ?? '',
      memoryMb: Number(labels[MEMORY_LABEL] ?? 0),
      spec,
      state: runningState(),
    })
    for (const [network, endpoint] of Object.entries(spec.NetworkingConfig?.EndpointsConfig ?? {})) {
      this.joinNetwork(name, network, endpoint.Aliases ?? [])
    }
  }

  async state(name: string): Promise<ContainerState> {
    return { ...(this.containers.get(name)?.state ?? MISSING) }
  }

  async stopAndRemove(name: string, _timeoutSec: number): Promise<void> {
    this.events.push(`stop ${name}`)
    this.containers.delete(name)
    this.endpoints.delete(name)
  }

  async restart(name: string): Promise<void> {
    const container = this.containers.get(name)
    if (!container) throw new Error(`no container ${name}`)
    this.events.push(`restart ${name}`)
    // Like `docker restart`: Docker's RestartCount only counts restarts by the restart policy.
    container.state = { ...container.state, running: true, restarting: false }
  }

  async listManaged(): Promise<ManagedContainer[]> {
    return [...this.containers.values()].map(({ name, deploymentId, serviceInstanceId, memoryMb, state }) => ({
      name,
      deploymentId,
      serviceInstanceId,
      memoryMb,
      running: state.running || state.restarting,
    }))
  }

  async imageExists(tag: string): Promise<boolean> {
    return this.existingImages.has(tag)
  }

  async removeImage(tag: string): Promise<void> {
    this.existingImages.delete(tag)
  }

  onContainerDie(cb: (name: string) => void, onError?: (err: Error) => void): () => void {
    const subscription = { cb, onError }
    this.dieSubscriptions.add(subscription)
    return () => {
      this.dieSubscriptions.delete(subscription)
    }
  }
}

export type FakeDeps = PipelineDeps & { docker: FakeDocker; events: string[] }

/**
 * Pipeline dependencies on a real (test) database with every other dependency faked. Every fake
 * records into one shared `events` list: `fetch`, `build` (buildImage only), `run <name>`, `health`,
 * `routes`, `sleep <ms>`, `stop <name>`, `cleanup`. `config.workDir` is a fresh temporary directory
 * that the caller removes afterwards.
 */
export function fakeDeps(db: Db, overrides: Partial<FakeDeps> = {}): FakeDeps {
  const events = overrides.events ?? overrides.docker?.events ?? []
  const docker = overrides.docker ?? new FakeDocker(events)
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpsm-pipeline-'))
  return {
    db,
    docker,
    events,
    config: loadConfig({ APPS_DOMAIN: 'apps.example.com', WORK_DIR: workDir }),
    run: async (cmd, args) => {
      throw new Error(`fake run: unexpected command ${cmd} ${args.join(' ')}`)
    },
    sleep: async (ms) => {
      events.push(`sleep ${ms}`)
    },
    // Like a clone: leaves files in destDir.
    fetchSource: async (i) => {
      events.push('fetch')
      const contextDir = path.join(i.destDir, i.rootDirectory ?? '')
      fs.mkdirSync(contextDir, { recursive: true })
      fs.writeFileSync(path.join(contextDir, 'index.js'), 'console.log("hi")\n')
      return { commitSha: 'abc123', commitMessage: 'test commit', contextDir }
    },
    chooseBuilder: async () => 'railpack',
    railpackPrepare: async (i) => ({
      planPath: path.join(i.outDir, 'railpack-plan.json'),
      infoPath: path.join(i.outDir, 'railpack-info.json'),
    }),
    buildImage: async (i) => {
      events.push('build')
      docker.existingImages.add(i.tag)
    },
    waitHealthy: async () => {
      events.push('health')
      return { ok: true }
    },
    regenerateRoutes: async () => {
      events.push('routes')
    },
    cleanupImages: async () => {
      events.push('cleanup')
    },
    ...overrides,
  }
}
