import type { DeployConfig } from '@vpsm/core'
import type Dockerode from 'dockerode'

export const MANAGED_LABEL = 'vpsm.managed'
export const DEPLOYMENT_LABEL = 'vpsm.deployment-id'
export const INSTANCE_LABEL = 'vpsm.service-instance-id'
export const MEMORY_LABEL = 'vpsm.memory-mb'

const MIB = 1024 * 1024
const PIDS_LIMIT = 512
export const MIN_MEMORY_MB = 6 // Docker refuses less
const MIN_NANO_CPUS = 1e7 // 0.01 CPU
/**
 * When the host runs out of memory the kernel kills user apps (and builds) before the control plane:
 * docker-compose.yml gives postgres, traefik and the worker -900.
 */
const OOM_SCORE_ADJ = 500
// Docker's default capability set minus the ones a web app has no use for.
const DROPPED_CAPABILITIES = ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP', 'SETPCAP', 'SYS_CHROOT']

export type ContainerSpecInput = {
  name: string
  image: string
  env: Record<string, string>
  deploy: DeployConfig
  cmd?: string[]
  networkName: string
  aliases: string[]
  deploymentId: string
  serviceInstanceId: string
}

function restartPolicy(deploy: DeployConfig): Dockerode.HostConfig['RestartPolicy'] {
  switch (deploy.restartPolicy) {
    case 'always':
      return { Name: 'unless-stopped' }
    case 'on_failure':
      return { Name: 'on-failure', MaximumRetryCount: deploy.restartMaxRetries }
    case 'never':
      return { Name: 'no' }
  }
}

/**
 * Why Docker would refuse these limits or treat one as "unlimited", or `undefined` when they are fine.
 * Docker reads Memory 0 and NanoCpus 0 as "unlimited" (NaN is serialised as null, i.e. 0), so never let one through.
 */
export function resourceLimitError({ memoryLimitMB, cpuLimit }: Pick<DeployConfig, 'memoryLimitMB' | 'cpuLimit'>): string | undefined {
  if (!Number.isInteger(memoryLimitMB) || memoryLimitMB < MIN_MEMORY_MB) {
    return `invalid memory limit: ${memoryLimitMB} MB (must be an integer of at least ${MIN_MEMORY_MB})`
  }
  const nanoCpus = Math.round(cpuLimit * 1e9)
  if (!Number.isFinite(nanoCpus) || nanoCpus < MIN_NANO_CPUS) {
    return `invalid CPU limit: ${cpuLimit} (must be at least ${MIN_NANO_CPUS / 1e9})`
  }
  return undefined
}

/**
 * The create options for one user container: resource limits, OOM priority, security
 * baseline, log rotation and restart policy. Nothing is published to the host and nothing
 * is bind-mounted; the container is reachable only through its network alias.
 * Throws on a memory or CPU limit that Docker would treat as "unlimited" (see `resourceLimitError`).
 */
export function buildContainerSpec(i: ContainerSpecInput): Dockerode.ContainerCreateOptions {
  const invalid = resourceLimitError(i.deploy)
  if (invalid !== undefined) throw new Error(invalid)
  const { memoryLimitMB, cpuLimit } = i.deploy
  const nanoCpus = Math.round(cpuLimit * 1e9)

  const memory = memoryLimitMB * MIB
  return {
    name: i.name,
    Image: i.image,
    ...(i.cmd && i.cmd.length > 0 ? { Cmd: i.cmd } : {}),
    Env: Object.keys(i.env)
      .sort()
      .map((key) => `${key}=${i.env[key]}`),
    Labels: {
      [MANAGED_LABEL]: 'true',
      [DEPLOYMENT_LABEL]: i.deploymentId,
      [INSTANCE_LABEL]: i.serviceInstanceId,
      [MEMORY_LABEL]: String(memoryLimitMB),
    },
    HostConfig: {
      Memory: memory,
      MemorySwap: memory, // equal to Memory: no swap
      NanoCpus: nanoCpus,
      OomScoreAdj: OOM_SCORE_ADJ,
      PidsLimit: PIDS_LIMIT,
      Privileged: false,
      SecurityOpt: ['no-new-privileges:true'],
      CapDrop: DROPPED_CAPABILITIES,
      RestartPolicy: restartPolicy(i.deploy),
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      NetworkMode: i.networkName,
    },
    NetworkingConfig: { EndpointsConfig: { [i.networkName]: { Aliases: i.aliases } } },
  }
}
