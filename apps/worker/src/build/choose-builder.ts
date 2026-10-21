import fs from 'node:fs/promises'
import type { BuildConfig } from '@vpsm/core'
import { isInside, resolveDockerfilePath } from './dockerfile-path'
import { BuildError } from './errors'

/**
 * Decides how to build the checked-out source. The Dockerfile (`dockerfilePath`, default `Dockerfile`,
 * repo-relative) must stay inside `contextDir`, also after following symlinks, so a repository cannot
 * make the build read files from elsewhere on the host.
 */
export async function chooseBuilder(contextDir: string, build: BuildConfig): Promise<'railpack' | 'dockerfile'> {
  if (build.builder === 'railpack') return 'railpack'

  const configured = build.dockerfilePath || 'Dockerfile'
  const resolved = resolveDockerfilePath(contextDir, configured)

  const real = await fs.realpath(resolved).catch(() => undefined)
  const isFile = real !== undefined && (await fs.stat(real)).isFile()
  if (!isFile) {
    if (build.builder === 'dockerfile') throw new BuildError(`Dockerfile not found at ${configured}`)
    return 'railpack'
  }
  if (!isInside(await fs.realpath(contextDir), real)) {
    throw new BuildError(`dockerfilePath must stay inside the repository: ${configured}`)
  }
  return 'dockerfile'
}
