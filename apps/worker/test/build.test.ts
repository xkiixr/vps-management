import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { BuildError } from '../src/build/errors'
import { chooseBuilder } from '../src/build/choose-builder'
import { railpackPrepare } from '../src/build/railpack'
import { buildImage, ensureBuilder } from '../src/build/build-image'
import type { RunCommand, RunOptions, RunResult } from '../src/exec'

type Call = [string, string[]]
type FakeRun = RunCommand & { calls: Call[]; opts: (RunOptions | undefined)[] }

/** Records every call and answers with the given exit codes, in order. */
function fakeRun(codes: number[], onCall?: (call: Call, index: number) => void): FakeRun {
  const calls: Call[] = []
  const opts: (RunOptions | undefined)[] = []
  const run = (async (cmd, args, o) => {
    const index = calls.length
    calls.push([cmd, args])
    opts.push(o)
    onCall?.([cmd, args], index)
    return { exitCode: codes[index] ?? 0, timedOut: false }
  }) as FakeRun
  run.calls = calls
  run.opts = opts
  return run
}

function fakeRunResult(result: RunResult): FakeRun {
  const calls: Call[] = []
  const opts: (RunOptions | undefined)[] = []
  const run = (async (cmd, args, o) => {
    calls.push([cmd, args])
    opts.push(o)
    return result
  }) as FakeRun
  run.calls = calls
  run.opts = opts
  return run
}

let root: string
let counter = 0

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpsm-build-test-'))
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function tmpDir(): string {
  const dir = path.join(root, `d${counter++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

describe('chooseBuilder', () => {
  test('auto picks dockerfile when present, railpack otherwise', async () => {
    const withFile = tmpDir()
    fs.writeFileSync(path.join(withFile, 'Dockerfile'), 'FROM scratch\n')
    const without = tmpDir()
    expect(await chooseBuilder(withFile, { builder: 'auto' })).toBe('dockerfile')
    expect(await chooseBuilder(without, { builder: 'auto' })).toBe('railpack')
  })

  test('auto honours a custom dockerfilePath', async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'docker'))
    fs.writeFileSync(path.join(dir, 'docker', 'prod.Dockerfile'), 'FROM scratch\n')
    expect(await chooseBuilder(dir, { builder: 'auto', dockerfilePath: 'docker/prod.Dockerfile' })).toBe('dockerfile')
    expect(await chooseBuilder(dir, { builder: 'auto' })).toBe('railpack')
  })

  test('auto ignores a directory named Dockerfile', async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'Dockerfile'))
    expect(await chooseBuilder(dir, { builder: 'auto' })).toBe('railpack')
  })

  test('explicit railpack ignores an existing Dockerfile', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n')
    expect(await chooseBuilder(dir, { builder: 'railpack' })).toBe('railpack')
  })

  test('explicit dockerfile is returned when the file exists', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n')
    expect(await chooseBuilder(dir, { builder: 'dockerfile' })).toBe('dockerfile')
  })

  test('explicit dockerfile with no file fails with the path', async () => {
    const dir = tmpDir()
    await expect(chooseBuilder(dir, { builder: 'dockerfile' })).rejects.toThrow('Dockerfile not found at Dockerfile')
    await expect(chooseBuilder(dir, { builder: 'dockerfile', dockerfilePath: 'deploy/App.Dockerfile' })).rejects.toThrow(
      'Dockerfile not found at deploy/App.Dockerfile',
    )
  })

  test('dockerfilePath outside context is rejected', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(path.dirname(dir), 'Dockerfile'), 'FROM scratch\n')
    await expect(chooseBuilder(dir, { builder: 'dockerfile', dockerfilePath: '../Dockerfile' })).rejects.toBeInstanceOf(
      BuildError,
    )
    await expect(chooseBuilder(dir, { builder: 'auto', dockerfilePath: '../Dockerfile' })).rejects.toBeInstanceOf(BuildError)
    await expect(chooseBuilder(dir, { builder: 'dockerfile', dockerfilePath: '/../Dockerfile' })).rejects.toBeInstanceOf(
      BuildError,
    )
    await expect(chooseBuilder(dir, { builder: 'dockerfile', dockerfilePath: './docker/../../Dockerfile' })).rejects.toBeInstanceOf(
      BuildError,
    )
  })

  test('a leading / or ./ in dockerfilePath means repo-relative, never the host filesystem', async () => {
    const dir = tmpDir()
    fs.mkdirSync(path.join(dir, 'docker'))
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n')
    fs.writeFileSync(path.join(dir, 'docker', 'Dockerfile'), 'FROM scratch\n')
    for (const dockerfilePath of ['/Dockerfile', './Dockerfile', '/docker/Dockerfile', './docker/Dockerfile']) {
      expect(await chooseBuilder(dir, { builder: 'dockerfile', dockerfilePath })).toBe('dockerfile')
    }
    // An absolute host path does not reach outside the repository: it is looked up inside it.
    const hostFile = path.join(tmpDir(), 'Dockerfile')
    fs.writeFileSync(hostFile, 'FROM scratch\n')
    await expect(chooseBuilder(dir, { builder: 'dockerfile', dockerfilePath: hostFile })).rejects.toThrow(
      `Dockerfile not found at ${hostFile}`,
    )
    expect(await chooseBuilder(dir, { builder: 'auto', dockerfilePath: '/nope/Dockerfile' })).toBe('railpack')
  })

  test('a Dockerfile symlinked to outside the context is rejected', async () => {
    const dir = tmpDir()
    const outside = path.join(tmpDir(), 'Secret')
    fs.writeFileSync(outside, 'FROM scratch\n')
    fs.symlinkSync(outside, path.join(dir, 'Dockerfile'))
    await expect(chooseBuilder(dir, { builder: 'dockerfile' })).rejects.toBeInstanceOf(BuildError)
    await expect(chooseBuilder(dir, { builder: 'auto' })).rejects.toBeInstanceOf(BuildError)
  })
})

describe('railpackPrepare', () => {
  const base = { contextDir: '/src', outDir: '/out', build: { builder: 'auto' as const }, onLine: () => {} }

  test('passes build and start commands as railpack env', async () => {
    const run = fakeRun([0])
    const result = await railpackPrepare({
      contextDir: '/src',
      outDir: '/out',
      build: { builder: 'auto', buildCommand: 'npm run build' },
      startCommand: 'node server.js',
      onLine: () => {},
      run,
    })
    expect(run.calls[0]).toEqual([
      'railpack',
      [
        'prepare',
        '/src',
        '--plan-out',
        '/out/railpack-plan.json',
        '--info-out',
        '/out/railpack-info.json',
        '--env',
        'RAILPACK_BUILD_CMD=npm run build',
        '--env',
        'RAILPACK_START_CMD=node server.js',
      ],
    ])
    expect(result).toEqual({ planPath: '/out/railpack-plan.json', infoPath: '/out/railpack-info.json' })
  })

  test('passes no env when no commands are configured, and streams output to onLine', async () => {
    const run = fakeRun([0])
    const onLine = () => {}
    await railpackPrepare({ ...base, onLine, run })
    expect(run.calls[0]).toEqual([
      'railpack',
      ['prepare', '/src', '--plan-out', '/out/railpack-plan.json', '--info-out', '/out/railpack-info.json'],
    ])
    expect(run.opts[0]?.onLine).toBe(onLine)
  })

  test('retries exit 75 up to 3 attempts', async () => {
    const run = fakeRun([75, 75, 0])
    const sleeps: number[] = []
    await railpackPrepare({
      ...base,
      run,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    })
    expect(run.calls).toHaveLength(3)
    expect(sleeps).toEqual([2000, 4000])
  })

  test('gives up after 3 transient failures without sleeping after the last', async () => {
    const run = fakeRun([75, 75, 75])
    const sleeps: number[] = []
    await expect(
      railpackPrepare({
        ...base,
        run,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      }),
    ).rejects.toThrow('railpack prepare failed after 3 attempts')
    expect(run.calls).toHaveLength(3)
    expect(sleeps).toEqual([2000, 4000])
  })

  describe('exit 1', () => {
    function runWritingInfo(outDir: string, info: string | undefined): FakeRun {
      return fakeRun([1], () => {
        if (info !== undefined) fs.writeFileSync(path.join(outDir, 'railpack-info.json'), info)
      })
    }

    test('fails at once with railpack messages', async () => {
      const outDir = tmpDir()
      const run = runWritingInfo(
        outDir,
        '{"success":false,"logs":[{"Level":"error","Msg":"No start command found"}]}',
      )
      await expect(railpackPrepare({ ...base, outDir, run })).rejects.toThrow(
        'railpack could not plan this app: No start command found',
      )
      expect(run.calls).toHaveLength(1)
    })

    const failure = async (logs: unknown[]) => {
      const outDir = tmpDir()
      const err = await railpackPrepare({
        ...base,
        outDir,
        run: runWritingInfo(outDir, JSON.stringify({ success: false, logs })),
      }).catch((e) => e)
      expect(err).toBeInstanceOf(BuildError)
      return err.message as string
    }

    test('joins several error messages with "; "', async () => {
      expect(
        await failure([
          { Level: 'error', Msg: 'first' },
          { Level: 'error', Msg: 'second' },
        ]),
      ).toBe('railpack could not plan this app: first; second')
    })

    test('prefers error-level messages over warnings and suggestions', async () => {
      expect(
        await failure([
          { Level: 'warn', Msg: 'script start.sh not found' },
          { Level: 'suggestion', Msg: 'Add a .dockerignore' },
          { Level: 'ERROR', Msg: 'could not determine how to build the app' },
          { Level: 'info', Msg: 'Detected Node' },
        ]),
      ).toBe('railpack could not plan this app: could not determine how to build the app')
    })

    test('falls back to every message when none is error-level', async () => {
      expect(
        await failure([
          { Level: 'warn', Msg: 'first' },
          { Level: 'info', Msg: 'second' },
          { Msg: 'third' },
        ]),
      ).toBe('railpack could not plan this app: first; second; third')
    })

    test('collapses newlines and runs of whitespace into single spaces', async () => {
      expect(
        await failure([
          { Level: 'error', Msg: 'Could not determine\n\nthe languages:\n- Php\n- Node \t ok\r\n' },
          { Level: 'error', Msg: '   ' },
        ]),
      ).toBe('railpack could not plan this app: Could not determine the languages: - Php - Node ok')
    })

    test('caps the messages at 500 characters and marks the cut with an ellipsis', async () => {
      const long = await failure([{ Level: 'error', Msg: 'x'.repeat(1000) }])
      expect(long).toBe(`railpack could not plan this app: ${'x'.repeat(500)}…`)
      // Exactly at the limit is left alone.
      const exact = await failure([{ Level: 'error', Msg: 'y'.repeat(500) }])
      expect(exact).toBe(`railpack could not plan this app: ${'y'.repeat(500)}`)
    })

    test.each([
      ['info file missing', undefined],
      ['info file not JSON', 'not json {'],
      ['no logs', '{"success":false}'],
      ['empty logs', '{"success":false,"logs":[]}'],
    ])('has no suffix when %s', async (_name, info) => {
      const outDir = tmpDir()
      const err = await railpackPrepare({ ...base, outDir, run: runWritingInfo(outDir, info) }).catch((e) => e)
      expect(err).toBeInstanceOf(BuildError)
      expect(err.message).toBe('railpack could not plan this app')
    })
  })

  describe('timeout', () => {
    test('defaults to 10 minutes and applies to every attempt', async () => {
      const run = fakeRun([75, 75, 0])
      await railpackPrepare({ ...base, run, sleep: async () => {} })
      expect(run.opts.map((o) => o?.timeoutMs)).toEqual([600_000, 600_000, 600_000])
    })

    test('uses the given timeoutMs', async () => {
      const run = fakeRun([0])
      await railpackPrepare({ ...base, run, timeoutMs: 30_000 })
      expect(run.opts[0]?.timeoutMs).toBe(30_000)
    })

    test('a timed out attempt fails at once, with no retry', async () => {
      const run = fakeRunResult({ exitCode: 124, timedOut: true })
      const sleeps: number[] = []
      const err = await railpackPrepare({
        ...base,
        run,
        sleep: async (ms) => {
          sleeps.push(ms)
        },
      }).catch((e) => e)
      expect(err).toBeInstanceOf(BuildError)
      expect(err.message).toBe('railpack prepare timed out after 10 minutes')
      expect(run.calls).toHaveLength(1)
      expect(sleeps).toEqual([])
    })

    test('a timeout after a transient failure is not retried either', async () => {
      const results = [{ exitCode: 75, timedOut: false }, { exitCode: 124, timedOut: true }]
      let n = 0
      const run = (async () => results[n++] ?? { exitCode: 0, timedOut: false }) as RunCommand
      await expect(railpackPrepare({ ...base, run, sleep: async () => {} })).rejects.toThrow(
        'railpack prepare timed out after 10 minutes',
      )
      expect(n).toBe(2)
    })

    test('describes the configured limit', async () => {
      const timedOut = fakeRunResult({ exitCode: 124, timedOut: true })
      await expect(railpackPrepare({ ...base, run: timedOut, timeoutMs: 60_000 })).rejects.toThrow(
        'railpack prepare timed out after 1 minute',
      )
      await expect(railpackPrepare({ ...base, run: timedOut, timeoutMs: 90_000 })).rejects.toThrow(
        'railpack prepare timed out after 90 seconds',
      )
    })
  })

  test('other exit codes fail with the code', async () => {
    const run = fakeRun([2])
    const err = await railpackPrepare({ ...base, run }).catch((e) => e)
    expect(err).toBeInstanceOf(BuildError)
    expect(err.message).toBe('railpack prepare exited with code 2')
    expect(run.calls).toHaveLength(1)
  })
})

describe('buildImage', () => {
  const railpackArgs = {
    builder: 'railpack' as const,
    contextDir: '/src',
    planPath: '/out/railpack-plan.json',
    tag: 'vpsm/si:d',
    cacheKey: 'si',
    frontendImage: 'ghcr.io/railwayapp/railpack-frontend:v0.43.0',
    timeoutMs: 1000,
    onLine: () => {},
  }

  test('uses railpack frontend through the vpsm builder', async () => {
    const run = fakeRun([0])
    await buildImage({ ...railpackArgs, run })
    expect(run.calls[0]).toEqual([
      'docker',
      [
        'buildx',
        'build',
        '--builder',
        'vpsm-builder',
        '--progress',
        'plain',
        '--load',
        '-t',
        'vpsm/si:d',
        '--build-arg',
        'BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.43.0',
        '--build-arg',
        'cache-key=si',
        '-f',
        '/out/railpack-plan.json',
        '/src',
      ],
    ])
    expect(run.opts[0]?.timeoutMs).toBe(1000)
    expect(run.opts[0]?.onLine).toBe(railpackArgs.onLine)
  })

  test('dockerfile build has no build-args and points -f into the context', async () => {
    const run = fakeRun([0, 0])
    const common = { contextDir: '/src', tag: 'vpsm/si:d', cacheKey: 'si', frontendImage: 'unused', timeoutMs: 1000, onLine: () => {}, run }
    await buildImage({ ...common, builder: 'dockerfile' })
    await buildImage({ ...common, builder: 'dockerfile', dockerfilePath: 'docker/prod.Dockerfile' })
    const expected = (file: string) => [
      'docker',
      ['buildx', 'build', '--builder', 'vpsm-builder', '--progress', 'plain', '--load', '-t', 'vpsm/si:d', '-f', file, '/src'],
    ]
    expect(run.calls[0]).toEqual(expected('/src/Dockerfile'))
    expect(run.calls[1]).toEqual(expected('/src/docker/prod.Dockerfile'))
  })

  test('dockerfilePath with a leading / or ./ is repo-relative, like chooseBuilder resolves it', async () => {
    const run = fakeRun([0, 0, 0])
    const common = { builder: 'dockerfile' as const, contextDir: '/src', tag: 't', cacheKey: 'k', frontendImage: 'f', timeoutMs: 1000, onLine: () => {}, run }
    await buildImage({ ...common, dockerfilePath: '/docker/Dockerfile' })
    await buildImage({ ...common, dockerfilePath: './docker/Dockerfile' })
    await buildImage({ ...common, dockerfilePath: '/Dockerfile' })
    const fileOf = (call: Call) => call[1][call[1].indexOf('-f') + 1]
    expect(run.calls.map(fileOf)).toEqual(['/src/docker/Dockerfile', '/src/docker/Dockerfile', '/src/Dockerfile'])
  })

  test('dockerfilePath escaping the context is rejected without running docker', async () => {
    const run = fakeRun([0])
    const common = { builder: 'dockerfile' as const, contextDir: '/src', tag: 't', cacheKey: 'k', frontendImage: 'f', timeoutMs: 1000, onLine: () => {}, run }
    for (const dockerfilePath of ['../Dockerfile', '/../Dockerfile', 'docker/../../Dockerfile']) {
      await expect(buildImage({ ...common, dockerfilePath })).rejects.toBeInstanceOf(BuildError)
    }
    expect(run.calls).toHaveLength(0)
  })

  test('reports timeout in minutes', async () => {
    await expect(
      buildImage({ ...railpackArgs, timeoutMs: 20 * 60_000, run: fakeRunResult({ exitCode: 124, timedOut: true }) }),
    ).rejects.toThrow('build timed out after 20 minutes')
  })

  test('reports a failed build with its exit code', async () => {
    const err = await buildImage({ ...railpackArgs, run: fakeRun([3]) }).catch((e) => e)
    expect(err).toBeInstanceOf(BuildError)
    expect(err.message).toBe('image build failed (exit code 3)')
  })

  test('railpack build without a plan is a programming error', async () => {
    const { planPath: _planPath, ...noPlan } = railpackArgs
    const run = fakeRun([0])
    await expect(buildImage({ ...noPlan, run })).rejects.toThrow('planPath')
    expect(run.calls).toHaveLength(0)
  })
})

describe('ensureBuilder', () => {
  test('creates a capped docker-container builder only when missing', async () => {
    const run = fakeRun([1, 0]) // inspect fails -> create
    await ensureBuilder(run, () => {})
    expect(run.calls[0]).toEqual(['docker', ['buildx', 'inspect', 'vpsm-builder']])
    expect(run.calls[1]).toEqual([
      'docker',
      [
        'buildx',
        'create',
        '--name',
        'vpsm-builder',
        '--driver',
        'docker-container',
        '--driver-opt',
        'memory=3g',
        '--driver-opt',
        'cpu-period=100000',
        '--driver-opt',
        'cpu-quota=300000',
      ],
    ])
    expect(run.calls).toHaveLength(2)
  })

  test('does nothing when the builder already exists', async () => {
    const run = fakeRun([0])
    await ensureBuilder(run, () => {})
    expect(run.calls).toEqual([['docker', ['buildx', 'inspect', 'vpsm-builder']]])
  })

  test('fails when the builder cannot be created', async () => {
    const err = await ensureBuilder(fakeRun([1, 7]), () => {}).catch((e) => e)
    expect(err).toBeInstanceOf(BuildError)
    expect(err.message).toBe('could not create buildx builder vpsm-builder (exit code 7)')
  })
})
