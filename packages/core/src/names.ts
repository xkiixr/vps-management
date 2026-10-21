const NAME_PATTERN = /^[a-z]([a-z0-9-]{0,28}[a-z0-9])?$/
const HOSTNAME_LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/
const MAX_HOSTNAME_LENGTH = 253
const MAX_LABEL_LENGTH = 63

export function validateName(name: string): { ok: true } | { ok: false; reason: string } {
  if (NAME_PATTERN.test(name)) return { ok: true }
  return {
    ok: false,
    reason: 'name must be 1-30 characters: lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen',
  }
}

export function isValidHostname(h: string): boolean {
  if (h.length === 0 || h.length > MAX_HOSTNAME_LENGTH) return false
  const labels = h.split('.')
  if (labels.length < 2) return false
  return labels.every((label) => label.length >= 1 && label.length <= MAX_LABEL_LENGTH && HOSTNAME_LABEL_PATTERN.test(label))
}

export function generatedHostname(serviceName: string, projectName: string, appsDomain: string): string {
  return `${serviceName}-${projectName}.${appsDomain}`
}

export function privateHostname(serviceName: string): string {
  return `${serviceName}.internal`
}

export function networkName(environmentId: string): string {
  return `vpsm-env-${environmentId}`
}

export function containerName(serviceName: string, deploymentId: string): string {
  return `vpsm-${serviceName}-${deploymentId.slice(0, 8)}`
}

export function imageTag(serviceInstanceId: string, deploymentId: string): string {
  return `vpsm/${serviceInstanceId}:${deploymentId}`
}
