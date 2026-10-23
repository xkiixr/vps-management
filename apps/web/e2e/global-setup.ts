import { type ChildProcess, spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createUser, generatePassword } from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { ADMIN_EMAIL, ADMIN_PASSWORD_VAR, E2E_ORIGIN, E2E_PORT, E2E_WEBHOOK_SECRET, TEAMMATE_EMAIL } from './env'

const webDir = path.resolve(import.meta.dirname, '..')
const SERVER_START_TIMEOUT_MS = 60_000
/** A server that is wedged (see the no-JS test in smoke.spec.ts) ignores SIGTERM, so it gets this long before SIGKILL. */
const SERVER_STOP_TIMEOUT_MS = 5_000

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk))
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${output}`))))
  })
}

/** True when something already accepts connections on the port, on either loopback address `localhost` can mean. */
async function portInUse(port: number): Promise<boolean> {
  const listening = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host })
      socket.once('connect', () => (socket.destroy(), resolve(true)))
      socket.once('error', () => resolve(false))
    })
  return (await listening('127.0.0.1')) || (await listening('::1'))
}

async function stop(server: ChildProcess): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return
  const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()))
  server.kill('SIGTERM')
  const timer = setTimeout(() => server.kill('SIGKILL'), SERVER_STOP_TIMEOUT_MS)
  await exited
  clearTimeout(timer)
}

async function waitUntilServing(server: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`the dashboard exited with ${server.exitCode}\n${output()}`)
    try {
      const response = await fetch(`${E2E_ORIGIN}/login`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) return
    } catch {
      // not listening yet
    }
    await sleep(250)
  }
  throw new Error(`the dashboard did not answer within ${SERVER_START_TIMEOUT_MS / 1000} s\n${output()}`)
}

// Builds the dashboard as the Docker image does, starts the standalone server on a scratch database that holds
// an admin and a second user, and returns what stops the server and drops the database.
export default async function globalSetup(): Promise<() => Promise<void>> {
  // Checked before anything is created: a leftover server (or a dev server) on this port would be mistaken for
  // the one under test, and the tests would run against another database.
  if (await portInUse(E2E_PORT)) {
    throw new Error(
      `port ${E2E_PORT} is already in use, so the dashboard under test cannot start there. Stop whatever listens on it (lsof -nP -iTCP:${E2E_PORT} -sTCP:LISTEN) and run the tests again.`,
    )
  }
  const testDb = await setupTestDb()
  let server: ChildProcess | undefined
  const teardown = async () => {
    try {
      if (server) await stop(server)
    } finally {
      await testDb.close()
    }
  }

  try {
    const adminPassword = generatePassword()
    await createUser(testDb.db, { email: ADMIN_EMAIL, name: 'Smoke Admin', role: 'admin', password: adminPassword })
    await createUser(testDb.db, { email: TEAMMATE_EMAIL, name: 'Smoke Teammate', role: 'member', password: generatePassword() })
    process.env[ADMIN_PASSWORD_VAR] = adminPassword

    await run('corepack', ['pnpm', 'run', 'build'], webDir)

    let log = ''
    server = spawn(process.execPath, ['.next/standalone/apps/web/server.js'], {
      cwd: webDir,
      // Nothing of the developer's environment (DATABASE_URL, ...) reaches the server.
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        NEXT_TELEMETRY_DISABLED: '1',
        PORT: String(E2E_PORT),
        HOSTNAME: '127.0.0.1',
        DATABASE_URL: testDb.url,
        APPS_DOMAIN: 'apps.example.com',
        PANEL_DOMAIN: 'panel.apps.example.com',
        PANEL_ORIGIN: E2E_ORIGIN,
        GITHUB_WEBHOOK_SECRET: E2E_WEBHOOK_SECRET,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    server.stdout?.on('data', (chunk: Buffer) => (log += chunk))
    server.stderr?.on('data', (chunk: Buffer) => (log += chunk))
    await waitUntilServing(server, () => log)
  } catch (error) {
    await teardown()
    throw error
  }
  return teardown
}
