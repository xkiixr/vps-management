import type { DeploymentTrigger } from '@vpsm/core'

/** `2026-10-22 17:09 UTC`: the same text on the server and in the browser, whatever either one's time zone. */
export function formatDateTime(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

const TRIGGER_LABELS: Record<DeploymentTrigger, string> = {
  push: 'Push',
  manual: 'Manual',
  rollback: 'Rollback',
  config: 'Settings change',
  restart: 'Restart',
}

/** What started a deployment, in words. */
export function triggerLabel(trigger: DeploymentTrigger): string {
  return TRIGGER_LABELS[trigger]
}

/** The first 7 characters of a commit hash, as git shows it by default. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/** The subject of a commit message: its first line. */
export function firstLine(message: string): string {
  return message.split('\n', 1)[0]!.trim()
}
