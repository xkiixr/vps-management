import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import http from 'node:http'
import { expect, type Page, type Response, test } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD_VAR, E2E_ORIGIN, E2E_PORT, E2E_WEBHOOK_SECRET, TEAMMATE_EMAIL } from './env'

test.skip(process.env.E2E !== '1', 'set E2E=1 to run the browser smoke test (see playwright.config.ts)')
// The tests share one server and one scratch database but not their data: each signs in on its own and works in a
// project of its own, so none needs another to have run (or passed).

async function signIn(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(ADMIN_EMAIL)
  await page.getByLabel('Password').fill(process.env[ADMIN_PASSWORD_VAR]!)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL('/')
}

test('sign in, create a project and a service, see it queued, sign out', async ({ page }) => {
  await test.step('opening the dashboard without a session leads to the sign-in page', async () => {
    await page.goto('/')
    await expect(page).toHaveURL('/login')
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  })

  await test.step('sign in as the administrator', async () => {
    await signIn(page)
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
    await expect(page.getByText('Smoke Admin')).toBeVisible()
  })

  await test.step('create the project "smoke"', async () => {
    await page.getByLabel('Name').fill('smoke')
    await page.getByRole('button', { name: 'Create project' }).click()
    await expect(page).toHaveURL('/projects/smoke')
    await expect(page.getByRole('heading', { name: 'smoke', exact: true })).toBeVisible()
  })

  await test.step('create the service "web" from acme/web', async () => {
    await page.getByLabel('Name', { exact: true }).fill('web')
    await page.getByLabel('Repository').fill('acme/web')
    await page.getByRole('button', { name: 'Create and deploy' }).click()
    await expect(page).toHaveURL('/projects/smoke/services/web')
    await expect(page.getByRole('heading', { name: 'web', exact: true })).toBeVisible()
  })

  await test.step('the first deployment is queued (no worker runs in this test)', async () => {
    const rows = page.getByRole('table').getByRole('row').filter({ has: page.locator('[data-status="QUEUED"]') })
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('Queued')
  })

  // The webhook is not for browsers: no session, no Origin, and the signature over the exact bytes is the only proof.
  await test.step('a signed push from GitHub queues a deployment of that commit; a forged one does not', async () => {
    const body = Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/main',
        after: 'c'.repeat(40),
        repository: { full_name: 'acme/web' },
        head_commit: { message: 'ship the smoke test\n\nand its details' },
        sender: { login: 'dev1' },
      }),
    )
    const deliver = (signature: string) =>
      page.request.post('/api/github/webhook', {
        data: body,
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'push',
          'x-github-delivery': 'smoke-delivery',
          'x-hub-signature-256': signature,
        },
      })

    const forged = await deliver('sha256=' + createHmac('sha256', 'another-secret-0123456789').update(body).digest('hex'))
    expect(forged.status()).toBe(401)
    expect(await forged.json()).toEqual({ error: 'invalid signature' })

    const response = await deliver('sha256=' + createHmac('sha256', E2E_WEBHOOK_SECRET).update(body).digest('hex'))
    expect(response.status()).toBe(202)
    expect(response.headers()['cache-control']).toBe('no-store')
    expect(await response.json()).toEqual({ queued: 1 })

    await page.reload()
    const rows = page.getByRole('table').getByRole('row')
    const pushed = rows.filter({ hasText: 'Push' })
    await expect(pushed).toHaveCount(1)
    await expect(pushed.first()).toContainText('ccccccc')
    await expect(pushed.first()).toContainText('ship the smoke test')
    await expect(pushed.first().locator('[data-status="QUEUED"]')).toHaveCount(1)
    // It replaced the first deployment, which was still waiting.
    await expect(rows.filter({ has: page.locator('[data-status="QUEUED"]') })).toHaveCount(1)
    await expect(rows.filter({ has: page.locator('[data-status="SKIPPED"]') })).toHaveCount(1)
  })

  await test.step('sign out, after which the dashboard asks for the sign-in again', async () => {
    await page.getByRole('button', { name: 'Log out' }).click()
    await expect(page).toHaveURL('/login')
    await page.goto('/')
    await expect(page).toHaveURL('/login')
  })
})

// A body sent in chunks without a Content-Length that grows past the 25 MiB limit. The server has to answer 413. It
// used to drop the connection instead: cancelling the incoming request body destroys its socket before the answer.
test('a webhook body that grows past 25 MiB is answered 413, not a reset connection', async () => {
  const MIB = 1024 * 1024
  const answer = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: E2E_PORT,
      path: '/api/github/webhook',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-event': 'push' },
    })
    const stop = new AbortController()
    request.setTimeout(10_000, () => request.destroy(new Error('no answer within 10 s')))
    request.on('error', reject)
    request.on('response', (response) => {
      response.resume()
      stop.abort()
      resolve({ status: response.statusCode ?? 0, connection: response.headers.connection })
    })
    // No end() until all is written, and no Content-Length: the request goes out as chunked.
    void (async () => {
      const chunk = Buffer.alloc(MIB, 0x20)
      for (let sent = 0; sent < 40 && !request.destroyed; sent += 1) {
        if (!request.write(chunk)) await once(request, 'drain', { signal: stop.signal })
      }
      request.end()
    })().catch(() => {
      // The server answered (stop) or the connection failed (the 'error' listener rejects).
    })
  })
  expect(answer).toEqual({ status: 413, connection: 'close' })

  // And the server is still serving the next, ordinary delivery.
  const body = '{"zen":"Keep it logically awesome."}'
  const ping = await fetch(`${E2E_ORIGIN}/api/github/webhook`, {
    method: 'POST',
    headers: {
      'x-github-event': 'ping',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', E2E_WEBHOOK_SECRET).update(body).digest('hex'),
    },
    body,
  })
  expect(ping.status).toBe(200)
})

// The panel is same-site with the team's apps, so one of them could frame it and have an admin click inside the
// frame (next.config.ts). The real server must send the headers that forbid it, before and after signing in.
test('no page of the panel can be framed, signed in or not', async ({ page }) => {
  const expectUnframeable = (response: Response | null) => {
    expect(response).not.toBeNull()
    const headers = response!.headers()
    expect(headers['x-frame-options']).toBe('DENY')
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
  }

  expectUnframeable(await page.goto('/login'))

  await signIn(page)
  const projects = await page.goto('/')
  await expect(page).toHaveURL('/')
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
  expectUnframeable(projects)
})

// Regression test for the hang found in Task 10b. Next 16 spun at 100% CPU, never answered and ignored SIGTERM
// when a browser without script posted a form whose action was bound INSIDE the component that holds its
// useActionState; the project guards against it (test/no-inner-bind.test.ts), and this proves a real server
// stays alive and answers. Run in a context with JavaScript off, as a signed-in administrator.
test.describe('a form posted without JavaScript', () => {
  const ANSWER_WITHIN_MS = 5_000

  test('is answered within 5 s, and the server still serves afterwards', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL: E2E_ORIGIN })
    try {
      const page = await context.newPage()

      /** Presses a button that posts a form and waits for the server's answer, which must come in time. */
      const post = async (button: ReturnType<Page['getByRole']>) => {
        const started = Date.now()
        const [response] = await Promise.all([
          page.waitForResponse((r) => r.request().method() === 'POST', { timeout: ANSWER_WITHIN_MS }),
          button.click(),
        ])
        await page.waitForLoadState('load', { timeout: ANSWER_WITHIN_MS })
        expect(response.status()).toBeLessThan(400)
        expect(Date.now() - started).toBeLessThan(ANSWER_WITHIN_MS)
      }

      await signIn(page)

      // The new-project form posts a plain action (no bound arguments).
      await page.getByLabel('Name').fill('nojs')
      await post(page.getByRole('button', { name: 'Create project' }))
      await expect(page).toHaveURL('/projects/nojs')

      // The members page binds its actions to the project and the user in the page and hands them to the forms.
      await page.goto('/projects/nojs/members')
      await expect(page.getByRole('cell', { name: ADMIN_EMAIL, exact: true })).toBeVisible()

      await page.getByLabel('Email').fill(TEAMMATE_EMAIL)
      await post(page.getByRole('button', { name: 'Add member' }))
      await expect(page.getByRole('cell', { name: TEAMMATE_EMAIL, exact: true })).toBeVisible()

      await post(page.getByRole('button', { name: `Remove ${TEAMMATE_EMAIL}` }))
      await expect(page.getByRole('cell', { name: TEAMMATE_EMAIL, exact: true })).toHaveCount(0)

      // A wedged server answers nothing, not even the sign-in page.
      const login = await context.request.get('/login', { timeout: ANSWER_WITHIN_MS })
      expect(login.status()).toBe(200)
    } finally {
      await context.close()
    }
  })
})
