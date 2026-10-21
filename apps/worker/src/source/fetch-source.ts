import fs from 'node:fs/promises'
import path from 'node:path'
import { runCommand, type LineHandler, type RunCommand } from '../exec'

export class SourceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceError'
  }
}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i

export function githubCloneUrl(repo: string, token?: string): string {
  if (!REPO_PATTERN.test(repo)) throw new SourceError(`invalid repo: ${repo}`)
  return token
    ? `https://x-access-token:${token}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`
}

export type FetchSourceInput = {
  cloneUrl: string
  branch: string
  commitSha?: string
  rootDirectory?: string
  destDir: string
  onLine: LineHandler
  /** Secrets (e.g. the token inside `cloneUrl`) that must never reach `onLine` or an error message. */
  redact: string[]
  run?: RunCommand
}

export type FetchedSource = { commitSha: string; commitMessage: string; contextDir: string }

const isInside = (parent: string, child: string) =>
  child === parent || child.startsWith(parent + path.sep)

export async function fetchSource(i: FetchSourceInput): Promise<FetchedSource> {
  const run = i.run ?? runCommand
  const repoDir = path.resolve(i.destDir)
  const contextDir = path.resolve(repoDir, i.rootDirectory ?? '')
  if (!isInside(repoDir, contextDir)) throw new SourceError('rootDirectory escapes repository')
  // A full object id also keeps a hostile value from being parsed as a git option.
  if (i.commitSha && !COMMIT_SHA_PATTERN.test(i.commitSha)) throw new SourceError('invalid commitSha')

  // Error messages below deliberately omit the clone URL, which may carry a token.
  const git = async (what: string, args: string[], onLine: LineHandler = i.onLine) => {
    const r = await run('git', args, {
      // Fail instead of prompting for credentials on a private repo with no/invalid token.
      env: { GIT_TERMINAL_PROMPT: '0' },
      onLine,
      redact: i.redact,
    })
    if (r.exitCode !== 0) throw new SourceError(`git ${what} failed (exit code ${r.exitCode})`)
  }

  await git('clone', [
    'clone',
    '--depth',
    '1',
    '--single-branch',
    '--branch',
    i.branch,
    '--',
    i.cloneUrl,
    repoDir,
  ])

  if (i.commitSha) {
    await git('fetch', ['-C', repoDir, 'fetch', '--depth', '1', 'origin', i.commitSha])
    await git('checkout', ['-C', repoDir, 'checkout', '--detach', i.commitSha])
  }

  const logLines: string[] = []
  await git(
    'log',
    ['-C', repoDir, 'log', '-1', '--format=%H%n%s'],
    (line, stream) => {
      if (stream === 'stdout') logLines.push(line)
    },
  )
  const [commitSha, commitMessage = ''] = logLines
  if (!commitSha) throw new SourceError('git log failed (no commit found)')

  if (i.rootDirectory) await checkRootDirectory(repoDir, contextDir, i.rootDirectory)
  return { commitSha, commitMessage, contextDir }
}

// Resolves symlinks so a link committed inside the repo cannot point the build context elsewhere.
async function checkRootDirectory(repoDir: string, contextDir: string, rootDirectory: string) {
  let realContext: string
  try {
    realContext = await fs.realpath(contextDir)
  } catch {
    throw new SourceError(`rootDirectory not found: ${rootDirectory}`)
  }
  if (!isInside(await fs.realpath(repoDir), realContext)) {
    throw new SourceError('rootDirectory escapes repository')
  }
  if (!(await fs.stat(realContext)).isDirectory()) {
    throw new SourceError(`rootDirectory is not a directory: ${rootDirectory}`)
  }
}
