export type SourceConfig = { repo: string; branch: string; rootDirectory?: string }

export type BuildConfig = {
  builder: 'auto' | 'railpack' | 'dockerfile'
  buildCommand?: string
  dockerfilePath?: string
}

export type RestartPolicy = 'always' | 'on_failure' | 'never'

export type DeployConfig = {
  startCommand?: string
  healthcheckPath?: string
  healthcheckTimeoutSec: number
  restartPolicy: RestartPolicy
  restartMaxRetries: number
  memoryLimitMB: number
  cpuLimit: number
  port: number
}

export type DeploymentTrigger = 'push' | 'manual' | 'rollback' | 'config'

export const DEFAULT_BUILD_CONFIG: BuildConfig = { builder: 'auto' }

export const DEFAULT_DEPLOY_CONFIG: DeployConfig = {
  healthcheckTimeoutSec: 300,
  restartPolicy: 'on_failure',
  restartMaxRetries: 10,
  memoryLimitMB: 512,
  cpuLimit: 1,
  port: 8080,
}
