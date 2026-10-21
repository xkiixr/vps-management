import fs from 'node:fs/promises'
import path from 'node:path'
import type { BuildConfig } from '@vpsm/core'
import { BuildError } from './errors'

const DEFAULT_DOCKERFILE = 'Dockerfile'

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * Decides how to build the checked-out source. `dockerfilePath` (default `Dockerfile`) is relative to
 * `contextDir` and must stay inside it, also after following symlinks, so a repository cannot make
 * the build read files from elsewhere on the host.
 */
export async function chooseBuilder(contextDir: string, build: BuildConfig): Promise<'railpack' | 'dockerfile'> {
  if (build.builder === 'railpack') return 'railpack'

  const dockerfilePath = build.dockerfilePath ?? DEFAULT_DOCKERFILE
  const resolved = path.resolve(contextDir, dockerfilePath)
  if (!isInside(path.resolve(contextDir), resolved)) {
    throw new BuildError(`dockerfilePath must stay inside the repository: ${dockerfilePath}`)
  }

  const real = await fs.realpath(resolved).catch(() => undefined)
  const isFile = real !== undefined && (await fs.stat(real)).isFile()
  if (!isFile) {
    if (build.builder === 'dockerfile') throw new BuildError(`Dockerfile not found at ${dockerfilePath}`)
    return 'railpack'
  }
  if (!isInside(await fs.realpath(contextDir), real)) {
    throw new BuildError(`dockerfilePath must stay inside the repository: ${dockerfilePath}`)
  }
  return 'dockerfile'
}
