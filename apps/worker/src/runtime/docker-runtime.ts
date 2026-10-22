import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import Dockerode from 'dockerode'
import { DEPLOYMENT_LABEL, INSTANCE_LABEL, MANAGED_LABEL, MEMORY_LABEL } from './container-spec'

export type ManagedContainer = {
  name: string
  deploymentId: string
  serviceInstanceId: string
  memoryMb: number
  /** Like Docker's own `State.Running`: true while the container runs or waits to be restarted. */
  running: boolean
}

export type ContainerState = {
  exists: boolean
  running: boolean
  restarting: boolean
  exitCode: number
  restartCount: number
  /** Docker's raw policy name: `on-failure`, `unless-stopped`, `no` (empty when the container does not exist). */
  restartPolicy: string
  maxRetries: number
}

export interface DockerRuntime {
  ensureNetwork(name: string): Promise<void>
  connect(containerName: string, networkName: string): Promise<void>
  /**
   * (Re)attaches a running container to `networkName` with exactly these DNS aliases: disconnects it
   * from that network if it is on it, then connects it with the aliases. The container keeps running.
   */
  attachAlias(containerName: string, networkName: string, aliases: string[]): Promise<void>
  run(spec: Dockerode.ContainerCreateOptions): Promise<void>
  state(name: string): Promise<ContainerState>
  stopAndRemove(name: string, timeoutSec: number): Promise<void>
  restart(name: string): Promise<void>
  listManaged(): Promise<ManagedContainer[]>
  imageExists(tag: string): Promise<boolean>
  removeImage(tag: string): Promise<void>
  /**
   * Calls `cb(name)` whenever a managed container's main process exits. Returns
   * the unsubscribe function. `onError` hears about a failed or broken event stream (no reconnect).
   */
  onContainerDie(cb: (name: string) => void, onError?: (err: Error) => void): () => void
}

const MISSING_STATE: ContainerState = {
  exists: false,
  running: false,
  restarting: false,
  exitCode: 0,
  restartCount: 0,
  restartPolicy: '',
  maxRetries: 0,
}

const statusCode = (err: unknown): number | undefined => (err as { statusCode?: number }).statusCode
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** Runs `fn`, turning "not found" into `undefined`. */
async function orMissing<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    if (statusCode(err) === 404) return undefined
    throw err
  }
}

export function createDockerRuntime(docker: Dockerode = new Dockerode()): DockerRuntime {
  const inspectContainer = (name: string) => orMissing(() => docker.getContainer(name).inspect())

  return {
    async ensureNetwork(name) {
      if (await orMissing(() => docker.getNetwork(name).inspect())) return
      try {
        await docker.createNetwork({ Name: name, Driver: 'bridge' })
      } catch (err) {
        // Created by someone else between the inspect and the create.
        if (statusCode(err) !== 409) throw err
      }
    },

    async connect(containerName, networkName) {
      const info = await docker.getContainer(containerName).inspect()
      if (info.NetworkSettings.Networks?.[networkName]) return
      try {
        await docker.getNetwork(networkName).connect({ Container: containerName })
      } catch (err) {
        if (!/already exists in network/.test(messageOf(err))) throw err
      }
    },

    async attachAlias(containerName, networkName, aliases) {
      const network = docker.getNetwork(networkName)
      try {
        await network.disconnect({ Container: containerName })
      } catch (err) {
        // The daemon answers 500 (older versions 403) with this message; anything else is real.
        if (!/is not connected to( the)? network/.test(messageOf(err))) throw err
      }
      await network.connect({ Container: containerName, EndpointConfig: { Aliases: aliases } })
    },

    async run(spec) {
      const name = spec.name
      if (name && (await inspectContainer(name))) {
        throw new Error(`container ${name} already exists`)
      }
      const container = await docker.createContainer(spec)
      try {
        await container.start()
      } catch (err) {
        // Leave nothing behind that would block the name.
        await container.remove({ force: true, v: true }).catch(() => undefined)
        throw err
      }
    },

    async state(name) {
      const info = await inspectContainer(name)
      if (!info) return { ...MISSING_STATE }
      const policy = info.HostConfig.RestartPolicy
      return {
        exists: true,
        running: info.State.Running,
        restarting: info.State.Restarting,
        exitCode: info.State.ExitCode,
        restartCount: info.RestartCount ?? 0,
        restartPolicy: policy?.Name ?? '',
        maxRetries: policy?.MaximumRetryCount ?? 0,
      }
    },

    async stopAndRemove(name, timeoutSec) {
      const container = docker.getContainer(name)
      try {
        await container.stop({ t: timeoutSec })
      } catch (err) {
        // 304: not running; 404: no such container (remove below is then a no-op too).
        if (statusCode(err) !== 304 && statusCode(err) !== 404) throw err
      }
      // `v` drops the container's anonymous volumes only (never named volumes or host paths).
      await orMissing(() => container.remove({ force: true, v: true }))
    },

    async restart(name) {
      await docker.getContainer(name).restart()
    },

    async listManaged() {
      const containers = await docker.listContainers({ all: true, filters: { label: [`${MANAGED_LABEL}=true`] } })
      return containers.map((c) => {
        const memoryMb = Number.parseInt(c.Labels[MEMORY_LABEL] ?? '', 10)
        return {
          name: (c.Names[0] ?? '').replace(/^\//, ''),
          deploymentId: c.Labels[DEPLOYMENT_LABEL] ?? '',
          serviceInstanceId: c.Labels[INSTANCE_LABEL] ?? '',
          memoryMb: Number.isFinite(memoryMb) && memoryMb > 0 ? memoryMb : 0,
          running: c.State === 'running' || c.State === 'restarting',
        }
      })
    },

    async imageExists(tag) {
      return (await orMissing(() => docker.getImage(tag).inspect())) !== undefined
    },

    async removeImage(tag) {
      try {
        await docker.getImage(tag).remove()
      } catch (err) {
        // 404: already gone; 409: still used by a container (or another tag family).
        if (statusCode(err) !== 404 && statusCode(err) !== 409) throw err
      }
    },

    onContainerDie(cb, onError) {
      const report = (err: unknown) => onError?.(toError(err))
      let stream: Readable | undefined
      let closed = false

      const handleLine = (line: string) => {
        if (line.trim() === '') return
        let event: { Actor?: { Attributes?: { name?: string } } }
        try {
          event = JSON.parse(line)
        } catch {
          return // not an event we understand
        }
        const name = event.Actor?.Attributes?.name
        if (!name) return
        try {
          cb(name)
        } catch (err) {
          report(err)
        }
      }

      docker
        .getEvents({ filters: { type: ['container'], event: ['die'], label: [`${MANAGED_LABEL}=true`] } })
        .then((s) => {
          const events = s as Readable
          if (closed) return void events.destroy()
          stream = events
          // The daemon sends one JSON document per line, but chunks may split them anywhere.
          const decoder = new StringDecoder('utf8')
          let pending = ''
          events.on('data', (chunk: Buffer) => {
            pending += decoder.write(chunk)
            const lines = pending.split('\n')
            pending = lines.pop() ?? ''
            lines.forEach(handleLine)
          })
          events.on('error', (err) => {
            if (!closed) report(err)
          })
          events.on('close', () => {
            if (!closed) report(new Error('docker event stream closed'))
          })
        })
        .catch(report)

      return () => {
        closed = true
        stream?.destroy()
      }
    },
  }
}
