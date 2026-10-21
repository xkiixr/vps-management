import path from 'node:path'
import { stripLeadingRoot } from '../repo-path'
import { BuildError } from './errors'

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

/**
 * The absolute path of the Dockerfile for a build context. `dockerfilePath` (default `Dockerfile`) is
 * relative to the repository, and a leading `/` or `./` means the same thing, as for `rootDirectory`.
 * Throws when it would leave `contextDir`. Choosing and building must both use this, so they agree.
 */
export function resolveDockerfilePath(contextDir: string, dockerfilePath?: string): string {
  const configured = dockerfilePath || 'Dockerfile'
  const root = path.resolve(contextDir)
  const resolved = path.resolve(root, stripLeadingRoot(configured))
  if (!isInside(root, resolved)) {
    throw new BuildError(`dockerfilePath must stay inside the repository: ${configured}`)
  }
  return resolved
}
