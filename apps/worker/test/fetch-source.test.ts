import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { runCommand, type RunCommand } from '../src/exec'
import { fetchSource, githubCloneUrl, SourceError } from '../src/source/fetch-source'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/** Every file under `dir` (recursively) whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return filesContaining(full, needle)
    return entry.isFile() && fs.readFileSync(full).includes(needle) ? [full] : []
  })
}

let root: string
let cloneUrl: string
let firstSha: string
let headSha: string
let outside: string
let counter = 0

const freshDest = () => path.join(root, `dest-${counter++}`)
const base = { branch: 'main', onLine: () => {}, redact: [] as string[] }

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpsm-fetch-source-'))
  const work = path.join(root, 'work')
  const bare = path.join(root, 'origin.git')
  outside = path.join(root, 'outside')
  fs.mkdirSync(path.join(work, 'app'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(work, 'app', 'index.js'), 'console.log("hi")\n')
  fs.writeFileSync(path.join(work, 'notes.txt'), 'not a directory\n')
  fs.symlinkSync(outside, path.join(work, 'escape'))
  git(work, 'init', '-b', 'main')
  git(work, 'add', '-A')
  git(work, 'commit', '-m', 'initial')
  firstSha = git(work, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(work, 'app', 'second.js'), '// second\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-m', 'second commit')
  headSha = git(work, 'rev-parse', 'HEAD')
  git(root, 'clone', '--bare', work, bare)
  cloneUrl = `file://${bare}`
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('fetchSource', () => {
  test('clones branch and reports commit', async () => {
    const destDir = freshDest()
    const r = await fetchSource({ ...base, cloneUrl, destDir })
    expect(r.commitSha).toBe(headSha)
    expect(r.commitMessage).toBe('second commit')
    expect(r.contextDir).toBe(destDir)
    expect(fs.existsSync(path.join(destDir, 'app', 'index.js'))).toBe(true)
  })

  test('checks out a pinned commitSha', async () => {
    const destDir = freshDest()
    const r = await fetchSource({ ...base, cloneUrl, commitSha: firstSha, destDir })
    expect(r.commitSha).toBe(firstSha)
    expect(r.commitMessage).toBe('initial')
    expect(fs.existsSync(path.join(destDir, 'app', 'second.js'))).toBe(false)
  })

  test('rejects a commitSha that is not a full hex object id', async () => {
    const destDir = freshDest()
    await expect(
      fetchSource({ ...base, cloneUrl, commitSha: '--upload-pack=touch pwned', destDir }),
    ).rejects.toThrow('invalid commitSha')
    expect(fs.existsSync(destDir)).toBe(false)
  })

  test('fails clearly when the pinned commit does not exist', async () => {
    const destDir = freshDest()
    await expect(
      fetchSource({ ...base, cloneUrl, commitSha: '0'.repeat(40), destDir }),
    ).rejects.toThrow('git fetch failed')
  })

  test('uses rootDirectory as context', async () => {
    const destDir = freshDest()
    const r = await fetchSource({ ...base, cloneUrl, rootDirectory: 'app', destDir })
    expect(r.contextDir).toBe(path.join(destDir, 'app'))
  })

  test('rejects rootDirectory outside the repo', async () => {
    const destDir = freshDest()
    await expect(fetchSource({ ...base, cloneUrl, rootDirectory: '../..', destDir })).rejects.toThrow(
      'rootDirectory escapes repository',
    )
    await expect(fetchSource({ ...base, cloneUrl, rootDirectory: '/../..', destDir })).rejects.toThrow(
      'rootDirectory escapes repository',
    )
    await expect(fetchSource({ ...base, cloneUrl, rootDirectory: './app/../..', destDir })).rejects.toThrow(
      'rootDirectory escapes repository',
    )
  })

  test('treats a leading slash or ./ as relative to the repository root', async () => {
    for (const rootDirectory of ['/app', './app', '//app/', '/./app']) {
      const destDir = freshDest()
      const r = await fetchSource({ ...base, cloneUrl, rootDirectory, destDir })
      expect(r.contextDir).toBe(path.join(destDir, 'app'))
    }
    const root = await fetchSource({ ...base, cloneUrl, rootDirectory: '/', destDir: freshDest() })
    expect(path.basename(root.contextDir)).toMatch(/^dest-\d+$/)
  })

  test('reports a missing absolute-looking rootDirectory as not found, not as an escape', async () => {
    await expect(
      fetchSource({ ...base, cloneUrl, rootDirectory: '/etc', destDir: freshDest() }),
    ).rejects.toThrow('rootDirectory not found: /etc')
  })

  test('rejects rootDirectory that is a symlink leaving the repo', async () => {
    await expect(
      fetchSource({ ...base, cloneUrl, rootDirectory: 'escape', destDir: freshDest() }),
    ).rejects.toThrow('rootDirectory escapes repository')
  })

  test('rejects missing rootDirectory', async () => {
    await expect(
      fetchSource({ ...base, cloneUrl, rootDirectory: 'nope', destDir: freshDest() }),
    ).rejects.toThrow('rootDirectory not found: nope')
  })

  test('rejects rootDirectory that is a file', async () => {
    await expect(
      fetchSource({ ...base, cloneUrl, rootDirectory: 'notes.txt', destDir: freshDest() }),
    ).rejects.toThrow('rootDirectory is not a directory: notes.txt')
  })

  test('fails clearly on unknown branch', async () => {
    const promise = fetchSource({ ...base, cloneUrl, branch: 'nope', destDir: freshDest() })
    await expect(promise).rejects.toThrow(SourceError)
    await expect(promise).rejects.toThrow('git clone failed')
  })

  test('never lets the token reach onLine or the thrown error', async () => {
    // Stand-in for a git that echoes the clone URL (token included) when it fails.
    const leakyGit: RunCommand = (_cmd, args, opts) =>
      runCommand(
        'node',
        ['-e', 'console.error("fatal: unable to access " + process.argv[1]); process.exit(128)', args.at(-2)!],
        opts,
      )
    const lines: string[] = []
    const url = githubCloneUrl('acme/web', 'tok-s3cr3t')
    expect(url).toContain('tok-s3cr3t')
    const error = await fetchSource({
      cloneUrl: url,
      branch: 'main',
      destDir: freshDest(),
      onLine: (l) => lines.push(l),
      redact: ['tok-s3cr3t'],
      run: leakyGit,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceError)
    expect((error as Error).message).toContain('git clone failed')
    expect((error as Error).message).not.toContain('tok-s3cr3t')
    expect(lines).toEqual(['fatal: unable to access https://x-access-token:***@github.com/acme/web.git'])
  })

  test.each([
    ['branch head', undefined],
    ['pinned commit', 'first'],
  ])('leaves no token on disk after cloning a token URL (%s)', async (_name, pin) => {
    // The URL carries a fake token but git is told (via insteadOf) to fetch from the local bare repo.
    const tokenUrl = githubCloneUrl('acme/web', 'FAKE-TOKEN')
    const viaLocalBare: RunCommand = (cmd, args, opts) =>
      runCommand(cmd, args, {
        ...opts,
        env: {
          ...opts?.env,
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `url.${cloneUrl}.insteadOf`,
          GIT_CONFIG_VALUE_0: tokenUrl,
        },
      })
    const destDir = freshDest()
    const r = await fetchSource({
      ...base,
      cloneUrl: tokenUrl,
      commitSha: pin ? firstSha : undefined,
      destDir,
      redact: ['FAKE-TOKEN'],
      run: viaLocalBare,
    })
    expect(r.commitSha).toBe(pin ? firstSha : headSha)

    const leaks = filesContaining(path.join(destDir, '.git'), 'FAKE-TOKEN')
    expect(leaks).toEqual([])
    expect(git(destDir, 'remote', '-v')).not.toContain('FAKE-TOKEN')
    expect(git(destDir, 'config', '--local', '--list')).not.toContain('FAKE-TOKEN')
  })

  test('passes redact, a line handler and a timeout to every git invocation', async () => {
    const calls: { step: string; redact?: string[]; hasOnLine: boolean; timeoutMs?: number }[] = []
    await fetchSource({
      ...base,
      cloneUrl,
      commitSha: firstSha,
      destDir: freshDest(),
      redact: ['secret-value'],
      run: (cmd, args, opts) => {
        const step = args.includes('-C') ? args[2]! : args[0]!
        calls.push({ step, redact: opts?.redact, hasOnLine: typeof opts?.onLine === 'function', timeoutMs: opts?.timeoutMs })
        return runCommand(cmd, args, opts)
      },
    })
    expect(calls.map((c) => c.step)).toEqual(['clone', 'fetch', 'remote', 'checkout', 'log'])
    for (const c of calls) expect(c.redact).toEqual(['secret-value'])
    expect(calls.every((c) => c.hasOnLine)).toBe(true)
    expect(calls.map((c) => c.timeoutMs)).toEqual([600_000, 600_000, 60_000, 60_000, 60_000])
  })

  test('timeouts are overridable', async () => {
    const seen: number[] = []
    await fetchSource({
      ...base,
      cloneUrl,
      commitSha: firstSha,
      destDir: freshDest(),
      timeouts: { networkMs: 120_000, localMs: 30_000 },
      run: (cmd, args, opts) => {
        seen.push(opts!.timeoutMs!)
        return runCommand(cmd, args, opts)
      },
    })
    expect(seen).toEqual([120_000, 120_000, 30_000, 30_000, 30_000])
  })

  test('reports a timed out clone as a SourceError in minutes', async () => {
    const run: RunCommand = async () => ({ exitCode: 124, timedOut: true })
    const error = await fetchSource({ ...base, cloneUrl, destDir: freshDest(), run }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SourceError)
    expect((error as Error).message).toBe('git clone timed out after 10 minutes')
  })

  test('uses the singular for a one minute timeout of a local git call', async () => {
    // Clone for real, then make the next call (removing the remote) time out.
    const run: RunCommand = (cmd, args, opts) =>
      args.includes('remote') ? Promise.resolve({ exitCode: 124, timedOut: true }) : runCommand(cmd, args, opts)
    await expect(fetchSource({ ...base, cloneUrl, destDir: freshDest(), run })).rejects.toThrow(
      'git remote timed out after 1 minute',
    )
  })

  test('formats overridden timeouts that are not whole minutes', async () => {
    const run: RunCommand = async () => ({ exitCode: 124, timedOut: true })
    await expect(
      fetchSource({ ...base, cloneUrl, destDir: freshDest(), run, timeouts: { networkMs: 90_000 } }),
    ).rejects.toThrow('git clone timed out after 90 seconds')
  })
})

describe('githubCloneUrl', () => {
  test('validates repo and embeds token', () => {
    expect(githubCloneUrl('acme/web', 't0k')).toBe('https://x-access-token:t0k@github.com/acme/web.git')
    expect(() => githubCloneUrl('acme/web; rm -rf /')).toThrow(SourceError)
  })

  test('omits credentials without a token', () => {
    expect(githubCloneUrl('acme/web')).toBe('https://github.com/acme/web.git')
  })

  test('rejects malformed repo names', () => {
    for (const bad of ['acme', 'acme/web/extra', '/web', 'acme/', 'a b/c', '']) {
      expect(() => githubCloneUrl(bad, 't')).toThrow(SourceError)
    }
  })

  test('does not leak the token in the error message', () => {
    expect(() => githubCloneUrl('bad repo', 'tok-s3cr3t')).toThrow(/invalid repo/)
    try {
      githubCloneUrl('bad repo', 'tok-s3cr3t')
    } catch (e) {
      expect((e as Error).message).not.toContain('tok-s3cr3t')
    }
  })
})
