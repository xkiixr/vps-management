import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { DEFAULT_DEPLOY_CONFIG } from '@vpsm/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { ContainerState } from '../src/runtime/docker-runtime'
import { healthMode, waitHealthy } from '../src/runtime/healthcheck'

const baseState: ContainerState = {
  exists: true,
  running: false,
  restarting: false,
  exitCode: 0,
  restartCount: 0,
  restartPolicy: 'on-failure',
  maxRetries: 10,
}
const alive = async (): Promise<ContainerState> => ({ ...baseState, running: true })

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()))
})

async function httpServer(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  )
  return (server.address() as AddressInfo).port
}

async function tcpServer(): Promise<number> {
  const server = net.createServer((socket) => socket.end())
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(() => new Promise((resolve) => server.close(() => resolve())))
  return (server.address() as AddressInfo).port
}

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

test('healthMode', () => {
  expect(healthMode({ ...DEFAULT_DEPLOY_CONFIG, healthcheckPath: '/health' }, false)).toBe('http')
  expect(healthMode({ ...DEFAULT_DEPLOY_CONFIG, healthcheckPath: '/health' }, true)).toBe('http')
  expect(healthMode(DEFAULT_DEPLOY_CONFIG, true)).toBe('tcp')
  expect(healthMode(DEFAULT_DEPLOY_CONFIG, false)).toBe('running')
})

describe('http mode', () => {
  test('passes on 2xx', async () => {
    const port = await httpServer((req, res) => {
      res.statusCode = req.url === '/health' ? 200 : 404
      res.end('ok')
    })
    const r = await waitHealthy({ host: '127.0.0.1', port, path: '/health', mode: 'http' }, { timeoutMs: 5000, intervalMs: 50, state: alive })
    expect(r).toEqual({ ok: true })
  })

  test('keeps waiting through 503 until the service turns healthy', async () => {
    let hits = 0
    const port = await httpServer((_req, res) => {
      res.statusCode = ++hits < 3 ? 503 : 204
      res.end()
    })
    const r = await waitHealthy({ host: '127.0.0.1', port, path: '/health', mode: 'http' }, { timeoutMs: 5000, intervalMs: 20, state: alive })
    expect(r).toEqual({ ok: true })
    expect(hits).toBe(3)
  })

  test('keeps waiting through 503 then times out with reason', async () => {
    const port = await httpServer((_req, res) => {
      res.statusCode = 503
      res.end()
    })
    const r = await waitHealthy({ host: '127.0.0.1', port, path: '/health', mode: 'http' }, { timeoutMs: 1000, intervalMs: 100, state: alive })
    expect(r).toEqual({ ok: false, reason: 'healthcheck timed out after 1s (last error: HTTP 503)' })
  })

  test('connection errors are reported as the last error', async () => {
    const port = await closedPort()
    const r = await waitHealthy({ host: '127.0.0.1', port, path: '/', mode: 'http' }, { timeoutMs: 1000, intervalMs: 100, state: alive })
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/^healthcheck timed out after 1s \(last error: .*ECONNREFUSED/) })
  })

  test('a probe that never answers cannot outlive the overall timeout', async () => {
    const port = await httpServer(() => {
      /* never respond */
    })
    const started = Date.now()
    const r = await waitHealthy({ host: '127.0.0.1', port, path: '/health', mode: 'http' }, { timeoutMs: 1000, intervalMs: 50, state: alive })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/^healthcheck timed out after 1s \(last error: .+\)$/) })
  })
})

describe('tcp mode', () => {
  test('passes when port accepts connections', async () => {
    const port = await tcpServer()
    const r = await waitHealthy({ host: '127.0.0.1', port, mode: 'tcp' }, { timeoutMs: 5000, intervalMs: 50, state: alive })
    expect(r).toEqual({ ok: true })
  })

  test('times out when nothing listens', async () => {
    const port = await closedPort()
    const r = await waitHealthy({ host: '127.0.0.1', port, mode: 'tcp' }, { timeoutMs: 1000, intervalMs: 100, state: alive })
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/^healthcheck timed out after 1s \(last error: .*ECONNREFUSED/) })
  })
})

test('fails fast when container exits', async () => {
  const started = Date.now()
  const r = await waitHealthy(
    { host: '127.0.0.1', port: 1, mode: 'tcp' },
    { timeoutMs: 60_000, intervalMs: 50, state: async () => ({ ...baseState, running: false, exitCode: 137 }) },
  )
  expect(r).toEqual({ ok: false, reason: 'container exited with code 137' })
  expect(Date.now() - started).toBeLessThan(2000)
})

describe('running mode', () => {
  test('needs the grace period', async () => {
    const started = Date.now()
    const r = await waitHealthy({ host: 'x', port: 0, mode: 'running' }, { timeoutMs: 5000, runningGraceMs: 200, intervalMs: 50, state: alive })
    expect(r).toEqual({ ok: true })
    expect(Date.now() - started).toBeGreaterThanOrEqual(190)
  })

  test('fails if the container exits during the grace period', async () => {
    let calls = 0
    const r = await waitHealthy(
      { host: 'x', port: 0, mode: 'running' },
      {
        timeoutMs: 5000,
        runningGraceMs: 1000,
        intervalMs: 50,
        state: async () => (++calls < 3 ? { ...baseState, running: true } : { ...baseState, running: false, exitCode: 1 }),
      },
    )
    expect(r).toEqual({ ok: false, reason: 'container exited with code 1' })
  })

  test('does not count a container that is mid-restart', async () => {
    let calls = 0
    const r = await waitHealthy(
      { host: 'x', port: 0, mode: 'running' },
      {
        timeoutMs: 5000,
        runningGraceMs: 100,
        intervalMs: 20,
        // Docker reports a container in restart back-off as running + restarting.
        state: async () => ({ ...baseState, running: true, restarting: ++calls < 10 }),
      },
    )
    expect(r).toEqual({ ok: true })
    expect(calls).toBeGreaterThanOrEqual(10)
  })

  test('a container that keeps restarting times out instead of passing', async () => {
    const r = await waitHealthy(
      { host: 'x', port: 0, mode: 'running' },
      {
        timeoutMs: 1000,
        runningGraceMs: 100,
        intervalMs: 50,
        state: async () => ({ ...baseState, running: true, restarting: true }),
      },
    )
    expect(r).toEqual({ ok: false, reason: 'healthcheck timed out after 1s (last error: container is restarting)' })
  })

  test('the grace period never exceeds the overall timeout', async () => {
    const r = await waitHealthy({ host: 'x', port: 0, mode: 'running' }, { timeoutMs: 300, runningGraceMs: 60_000, intervalMs: 20, state: alive })
    expect(r).toEqual({ ok: true })
  })
})
