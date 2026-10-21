import type { DeployConfig } from '@vpsm/core'
import type Dockerode from 'dockerode'

export const MANAGED_LABEL = 'vpsm.managed'
export const DEPLOYMENT_LABEL = 'vpsm.deployment-id'
export const INSTANCE_LABEL = 'vpsm.service-instance-id'
export const MEMORY_LABEL = 'vpsm.memory-mb'

const MIB = 1024 * 1024
const PIDS_LIMIT = 512
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
 * The create options for one user container: resource limits, security baseline,
 * log rotation and restart policy. Nothing is published to the host and nothing
 * is bind-mounted; the container is reachable only through its network alias.
 */
export function buildContainerSpec(i: ContainerSpecInput): Dockerode.ContainerCreateOptions {
  const memory = i.deploy.memoryLimitMB * MIB
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
      [MEMORY_LABEL]: String(i.deploy.memoryLimitMB),
    },
    HostConfig: {
      Memory: memory,
      MemorySwap: memory, // equal to Memory: no swap
      NanoCpus: Math.round(i.deploy.cpuLimit * 1e9),
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
