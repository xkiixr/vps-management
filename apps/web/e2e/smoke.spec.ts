import { expect, type Page, type Response, test } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD_VAR, E2E_ORIGIN, TEAMMATE_EMAIL } from './env'

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

  await test.step('sign out, after which the dashboard asks for the sign-in again', async () => {
    await page.getByRole('button', { name: 'Log out' }).click()
    await expect(page).toHaveURL('/login')
    await page.goto('/')
    await expect(page).toHaveURL('/login')
  })
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
