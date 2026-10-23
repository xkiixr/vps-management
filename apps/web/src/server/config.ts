import { z } from 'zod'
import { isValidHostname, publicUrl } from '@vpsm/core'

export type WebConfig = {
  databaseUrl: string
  appsDomain: string
  panelDomain: string
  httpsPort: number
  /** What a browser sends as `Origin` from the panel's own pages; every server action compares against it. */
  panelOrigin: string
  /** Shared with the GitHub App; without it the webhook endpoint answers 503. */
  githubWebhookSecret?: string
}

const hostname = (example: string) =>
  z.string({ error: 'is required' }).refine(isValidHostname, `must be a lowercase hostname such as ${example}`)

// `new URL(x).origin === x` holds only for a bare scheme://host[:port]: no path, no trailing slash, no
// credentials, default ports left out, the host lowercase. That is exactly the form browsers send.
const isOrigin = (value: string) => {
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value
  } catch {
    return false
  }
}

const isPostgresUrl = (value: string) => {
  try {
    return ['postgres:', 'postgresql:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const schema = z.object({
  DATABASE_URL: z.string({ error: 'is required' }).refine(isPostgresUrl, 'must be a postgres:// URL'),
  APPS_DOMAIN: hostname('apps.example.com'),
  PANEL_DOMAIN: hostname('panel.apps.example.com'),
  PUBLIC_HTTPS_PORT: z.coerce.number().int().min(1).max(65535).default(443),
  // Dev and e2e only: the panel served somewhere other than https://PANEL_DOMAIN[:PUBLIC_HTTPS_PORT].
  PANEL_ORIGIN: z
    .string()
    .refine(isOrigin, 'must be a bare origin such as http://localhost:3100 (no path or trailing slash)')
    .optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters').optional(),
})

/** Reads the dashboard's settings from the environment. Throws one message naming every bad variable (never their values). */
export function webConfig(env: Record<string, string | undefined> = process.env): WebConfig {
  // `FOO=` in an .env file means "not set", not "set to nothing".
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''))
  const result = schema.safeParse(present)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`)
    throw new Error(`invalid web configuration: ${problems.join('; ')}`)
  }
  const e = result.data
  return {
    databaseUrl: e.DATABASE_URL,
    appsDomain: e.APPS_DOMAIN,
    panelDomain: e.PANEL_DOMAIN,
    httpsPort: e.PUBLIC_HTTPS_PORT,
    panelOrigin: e.PANEL_ORIGIN ?? publicUrl(e.PANEL_DOMAIN, e.PUBLIC_HTTPS_PORT),
    githubWebhookSecret: e.GITHUB_WEBHOOK_SECRET,
  }
}
