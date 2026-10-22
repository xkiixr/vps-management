export type FieldErrors = Partial<
  Record<'repo' | 'branch' | 'rootDirectory' | 'healthcheckPath' | 'port' | 'memoryLimitMB' | 'startCommand', string>
>

export type ServiceInput = {
  repo?: string
  branch?: string
  rootDirectory?: string
  healthcheckPath?: string
  port?: number
  memoryLimitMB?: number
  startCommand?: string
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const WHITESPACE_PATTERN = /\s/
const MIN_MEMORY_MB = 6
const MAX_PORT = 65535
const MAX_START_COMMAND_LENGTH = 1000

function isIntegerBetween(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max
}

/**
 * Checks the user-editable fields of a service. Fields that are not provided are not checked;
 * an empty object means every provided field is valid. Messages are shown to the user as they are.
 */
export function validateServiceInput(i: ServiceInput, limits: { maxServiceMemoryMb: number }): FieldErrors {
  const errors: FieldErrors = {}

  if (i.repo !== undefined && !REPO_PATTERN.test(i.repo)) {
    errors.repo = 'use the form owner/name'
  }

  if (i.branch !== undefined) {
    if (i.branch === '') errors.branch = 'branch is required'
    else if (WHITESPACE_PATTERN.test(i.branch) || i.branch.startsWith('-')) errors.branch = 'invalid branch name'
  }

  if (i.rootDirectory !== undefined && i.rootDirectory.split(/[\\/]/).includes('..')) {
    errors.rootDirectory = 'must stay inside the repository'
  }

  if (i.healthcheckPath !== undefined) {
    if (!i.healthcheckPath.startsWith('/')) errors.healthcheckPath = 'must start with /'
    else if (WHITESPACE_PATTERN.test(i.healthcheckPath)) errors.healthcheckPath = 'must not contain spaces'
  }

  if (i.port !== undefined && !isIntegerBetween(i.port, 1, MAX_PORT)) {
    errors.port = `must be between 1 and ${MAX_PORT}`
  }

  if (i.memoryLimitMB !== undefined && !isIntegerBetween(i.memoryLimitMB, MIN_MEMORY_MB, limits.maxServiceMemoryMb)) {
    errors.memoryLimitMB = `must be between ${MIN_MEMORY_MB} and ${limits.maxServiceMemoryMb} MB`
  }

  if (i.startCommand !== undefined && i.startCommand.length > MAX_START_COMMAND_LENGTH) {
    errors.startCommand = `must be at most ${MAX_START_COMMAND_LENGTH} characters`
  }

  return errors
}
