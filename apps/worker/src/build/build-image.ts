import path from 'node:path'
import { runCommand, type LineHandler, type RunCommand } from '../exec'
import { BuildError } from './errors'

export const BUILDER_NAME = 'vpsm-builder'

/** Builds are capped at 3 GB of memory and 3 of the machine's 4 CPUs (quota / period). */
const BUILDER_CREATE_ARGS = [
  'buildx',
  'create',
  '--name',
  BUILDER_NAME,
  '--driver',
  'docker-container',
  '--driver-opt',
  'memory=3g',
  '--driver-opt',
  'cpu-period=100000',
  '--driver-opt',
  'cpu-quota=300000',
]

/**
 * Makes sure the resource-capped buildx builder exists (created once, reused by every build).
 * Run once at worker startup.
 */
export async function ensureBuilder(run: RunCommand, onLine: LineHandler): Promise<void> {
  // No onLine here: inspecting an existing builder prints its whole description.
  const inspect = await run('docker', ['buildx', 'inspect', BUILDER_NAME])
  if (inspect.exitCode === 0) return
  const create = await run('docker', BUILDER_CREATE_ARGS, { onLine })
  if (create.exitCode !== 0) {
    throw new BuildError(`could not create buildx builder ${BUILDER_NAME} (exit code ${create.exitCode})`)
  }
}

/** Builds the image and loads it into the local Docker, through the capped builder. */
export async function buildImage(i: {
  builder: 'railpack' | 'dockerfile'
  contextDir: string
  planPath?: string
  dockerfilePath?: string
  tag: string
  cacheKey: string
  frontendImage: string
  timeoutMs: number
  onLine: LineHandler
  run?: RunCommand
}): Promise<void> {
  const run = i.run ?? runCommand
  const args = ['buildx', 'build', '--builder', BUILDER_NAME, '--progress', 'plain', '--load', '-t', i.tag]
  if (i.builder === 'railpack') {
    if (i.planPath === undefined) throw new Error('planPath is required for the railpack builder')
    args.push(
      '--build-arg',
      `BUILDKIT_SYNTAX=${i.frontendImage}`,
      '--build-arg',
      `cache-key=${i.cacheKey}`,
      '-f',
      i.planPath,
      i.contextDir,
    )
  } else {
    args.push('-f', path.join(i.contextDir, i.dockerfilePath ?? 'Dockerfile'), i.contextDir)
  }

  const { exitCode, timedOut } = await run('docker', args, { timeoutMs: i.timeoutMs, onLine: i.onLine })
  if (timedOut) throw new BuildError(`build timed out after ${Math.round(i.timeoutMs / 60_000)} minutes`)
  if (exitCode !== 0) throw new BuildError(`image build failed (exit code ${exitCode})`)
}
