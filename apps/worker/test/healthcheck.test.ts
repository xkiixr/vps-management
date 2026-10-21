import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { DEFAULT_DEPLOY_CONFIG } from '@vpsm/core'
import { afterEach, describe, expect, test, vi } from 'vitest'
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

/** A raw TCP server running `onConnection` for each client; its sockets are destroyed at cleanup. */
async function rawServer(onConnection: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    onConnection(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  closers.push(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  )
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

describe('http probe bounds', () => {
  test('a server that dribbles its headers cannot hold the probe past the overall timeout', async () => {
    const port = await rawServer((socket) => {
      socket.write('HTTP/1.1 200 OK\r\n')
      const timer = setInterval(() => socket.write('X-Slow: 1\r\n'), 50) // activity, so the idle timeout never fires
      socket.on('close', () => clearInterval(timer))
    })
    const started = Date.now()
    const r = await waitHealthy({ host: '127.0.0.1', port, path: '/health', mode: 'http' }, { timeoutMs: 1000, intervalMs: 50, state: alive })
    expect(Date.now() - started).toBeLessThan(2500)
    expect(r).toEqual({ ok: false, reason: 'healthcheck timed out after 1s (last error: timeout)' })
  })

  test('passes on the status line alone and drops the connection instead of reading a body that never ends', async () => {
    let serverSide: net.Socket | undefined
    const port = await httpServer((req, res) => {
      serverSide = req.socket
      res.writeHead(200, { 'content-length': 1_000_000_000 })
      res.write('x') // the rest never comes
    })
    const started = Date.now()
    const r = await waitHealthy({ host: '127.0.0.1', port, path: '/health', mode: 'http' }, { timeoutMs: 5000, intervalMs: 50, state: alive })
    expect(r).toEqual({ ok: true })
    expect(Date.now() - started).toBeLessThan(1500)
    await vi.waitFor(() => expect(serverSide?.destroyed).toBe(true), { timeout: 2000 })
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

test('fails when the container no longer exists', async () => {
  const r = await waitHealthy(
    { host: '127.0.0.1', port: 1, mode: 'http', path: '/' },
    { timeoutMs: 60_000, intervalMs: 50, state: async () => ({ ...baseState, exists: false }) },
  )
  expect(r).toEqual({ ok: false, reason: 'container disappeared' })
})

/** A `state()` fake for a container that stays "running" while Docker restarts it: restartCount grows, restarting is never true. */
const crashLooping =
  (restartCounts: number[]): (() => Promise<ContainerState>) =>
  async () => ({ ...baseState, running: true, restartCount: restartCounts.length > 1 ? restartCounts.shift()! : restartCounts[0], exitCode: 1 })

describe('restarts while running', () => {
  test('running mode fails as soon as the restart count rises', async () => {
    const started = Date.now()
    const r = await waitHealthy(
      { host: 'x', port: 0, mode: 'running' },
      { timeoutMs: 60_000, runningGraceMs: 10_000, intervalMs: 20, state: crashLooping([0, 0, 1]) },
    )
    expect(r).toEqual({ ok: false, reason: 'container restarted during startup (exit code 1)' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('running mode catches a restart that is first seen at the end of the grace period', async () => {
    // Only two samples are taken: at the start and at the end of the grace period. Docker restarted the container in
    // between, and by the second sample it is running again (restarting === false).
    let samples = 0
    const r = await waitHealthy(
      { host: 'x', port: 0, mode: 'running' },
      {
        timeoutMs: 5000,
        runningGraceMs: 150,
        intervalMs: 1000,
        state: async () => ({ ...baseState, running: true, restartCount: samples++ === 0 ? 0 : 1, exitCode: 1 }),
      },
    )
    expect(r).toEqual({ ok: false, reason: 'container restarted during startup (exit code 1)' })
  })

  test('running mode passes when the restart count is high but stable', async () => {
    const r = await waitHealthy({ host: 'x', port: 0, mode: 'running' }, { timeoutMs: 5000, runningGraceMs: 100, intervalMs: 20, state: crashLooping([4]) })
    expect(r).toEqual({ ok: true })
  })

  test('http mode keeps probing, and reports the restart if the probes never succeed', async () => {
    const port = await httpServer((_req, res) => {
      res.statusCode = 503
      res.end()
    })
    const r = await waitHealthy(
      { host: '127.0.0.1', port, path: '/health', mode: 'http' },
      { timeoutMs: 1000, intervalMs: 50, state: crashLooping([0, 1]) },
    )
    expect(r).toEqual({ ok: false, reason: 'healthcheck timed out after 1s (last error: container restarted (exit code 1))' })
  })

  test('tcp mode likewise reports the restart', async () => {
    const port = await closedPort()
    const r = await waitHealthy({ host: '127.0.0.1', port, mode: 'tcp' }, { timeoutMs: 1000, intervalMs: 50, state: crashLooping([0, 1]) })
    expect(r).toEqual({ ok: false, reason: 'healthcheck timed out after 1s (last error: container restarted (exit code 1))' })
  })

  test('an app that crashed once on boot but then answers still passes', async () => {
    let hits = 0
    const port = await httpServer((_req, res) => {
      res.statusCode = ++hits < 4 ? 503 : 200
      res.end()
    })
    const r = await waitHealthy(
      { host: '127.0.0.1', port, path: '/health', mode: 'http' },
      { timeoutMs: 5000, intervalMs: 20, state: crashLooping([0, 0, 1]) },
    )
    expect(r).toEqual({ ok: true })
  })
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
