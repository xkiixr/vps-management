import { describe, expect, test } from 'vitest'
import { runCommand } from '../src/exec'

describe('runCommand', () => {
  test('streams lines and returns exit code', async () => {
    const lines: string[] = []
    const r = await runCommand('node', ['-e', 'console.log("a\\nb"); process.exit(3)'], {
      onLine: (l) => lines.push(l),
    })
    expect(lines).toEqual(['a', 'b'])
    expect(r).toEqual({ exitCode: 3, timedOut: false })
  })

  test('redacts secrets before they reach onLine', async () => {
    const lines: string[] = []
    await runCommand('node', ['-e', 'console.log("token=s3cr3t")'], {
      onLine: (l) => lines.push(l),
      redact: ['s3cr3t'],
    })
    expect(lines).toEqual(['token=***'])
  })

  test('kills on timeout', async () => {
    expect(await runCommand('node', ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 200 })).toEqual({
      exitCode: 124,
      timedOut: true,
    })
  })

  test('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    const script = 'process.on("SIGTERM", () => {}); console.log("ready"); setTimeout(() => {}, 60000)'
    const started = Date.now()
    const r = await runCommand('node', ['-e', script], { timeoutMs: 300 })
    expect(r).toEqual({ exitCode: 124, timedOut: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000)
  }, 15_000)

  test('replaces every occurrence of every secret and ignores empty strings', async () => {
    const lines: string[] = []
    await runCommand('node', ['-e', 'console.log("aa-s1-s1-s2-aa")'], {
      onLine: (l) => lines.push(l),
      redact: ['', 's1', 's2'],
    })
    expect(lines).toEqual(['aa-***-***-***-aa'])
  })

  test('redacts the longer secret first when one contains the other', async () => {
    const lines: string[] = []
    await runCommand('node', ['-e', 'console.log("abcdef")'], {
      onLine: (l) => lines.push(l),
      redact: ['abc', 'abcdef'],
    })
    expect(lines).toEqual(['***'])
  })

  test('delivers a trailing line without newline and handles CRLF', async () => {
    const lines: string[] = []
    await runCommand('node', ['-e', 'process.stdout.write("one\\r\\ntwo\\r\\n\\nthree")'], {
      onLine: (l) => lines.push(l),
    })
    expect(lines).toEqual(['one', 'two', '', 'three'])
  })

  test('reassembles a line split across chunks before redacting', async () => {
    const script =
      'process.stdout.write("tok=s3c"); setTimeout(() => process.stdout.write("r3t done\\n"), 100)'
    const lines: string[] = []
    await runCommand('node', ['-e', script], { onLine: (l) => lines.push(l), redact: ['s3cr3t'] })
    expect(lines).toEqual(['tok=*** done'])
  })

  test('tags stdout and stderr lines with their stream', async () => {
    const seen: [string, string][] = []
    await runCommand('node', ['-e', 'console.log("out"); console.error("err")'], {
      onLine: (l, s) => seen.push([s, l]),
    })
    expect(seen).toHaveLength(2)
    expect(seen).toContainEqual(['stdout', 'out'])
    expect(seen).toContainEqual(['stderr', 'err'])
  })

  test('merges opts.env over process.env and honours cwd', async () => {
    const lines: string[] = []
    await runCommand('node', ['-e', 'console.log(process.env.VPSM_TEST_VAR, process.cwd())'], {
      env: { VPSM_TEST_VAR: 'hello' },
      cwd: '/',
      onLine: (l) => lines.push(l),
    })
    expect(lines).toEqual(['hello /'])
  })

  test('passes arguments verbatim without a shell', async () => {
    const lines: string[] = []
    const r = await runCommand('node', ['-e', 'console.log(process.argv[1])', '$(echo hacked); echo x'], {
      onLine: (l) => lines.push(l),
    })
    expect(r.exitCode).toBe(0)
    expect(lines).toEqual(['$(echo hacked); echo x'])
  })

  test('rejects when the command cannot be started', async () => {
    await expect(runCommand('vpsm-no-such-command', [])).rejects.toThrow('failed to start vpsm-no-such-command')
  })
})
