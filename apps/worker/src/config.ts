import path from 'node:path'
import { z } from 'zod'
import { isValidHostname } from '@vpsm/core'

export type WorkerConfig = {
  appsDomain: string
  traefikDynamicDir: string
  traefikContainer: string
  workerContainer: string
  frontendImage: string
  memoryBudgetMb: number
  maxServiceMemoryMb: number
  buildTimeoutMs: number
  drainSeconds: number
  imageRetention: number
  workDir: string
  githubToken?: string
}

const text = (fallback: string) => z.string().default(fallback)
const absolutePath = (fallback: string) => text(fallback).refine((p) => path.isAbsolute(p), 'must be an absolute path')
const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback)

const schema = z.object({
  APPS_DOMAIN: z
    .string({ error: 'is required' })
    .refine(isValidHostname, 'must be a lowercase hostname such as apps.example.com'),
  TRAEFIK_DYNAMIC_DIR: absolutePath('/traefik/dynamic'),
  TRAEFIK_CONTAINER: text('vpsm-traefik'),
  WORKER_CONTAINER: text('vpsm-worker'),
  // Must stay the same version as the railpack CLI in the worker image.
  RAILPACK_FRONTEND_IMAGE: text('ghcr.io/railwayapp/railpack-frontend:v0.43.0'),
  MEMORY_BUDGET_MB: positiveInt(5632),
  MAX_SERVICE_MEMORY_MB: positiveInt(2048),
  BUILD_TIMEOUT_MINUTES: positiveInt(20),
  DRAIN_SECONDS: z.coerce.number().int().nonnegative().default(10),
  IMAGE_RETENTION: positiveInt(5),
  // Each deployment's checkout lives in `${WORK_DIR}/<id>` and is deleted recursively afterwards.
  WORK_DIR: absolutePath('/var/lib/vpsm/work'),
  GITHUB_TOKEN: z.string().optional(),
})

/** Reads the worker's settings from the environment. Throws one message naming every bad variable (never their values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // `FOO=` in an .env file means "not set", not "set to nothing".
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''))
  const result = schema.safeParse(present)
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`)
    throw new Error(`invalid worker configuration: ${problems.join('; ')}`)
  }
  const e = result.data
  return {
    appsDomain: e.APPS_DOMAIN,
    traefikDynamicDir: e.TRAEFIK_DYNAMIC_DIR,
    traefikContainer: e.TRAEFIK_CONTAINER,
    workerContainer: e.WORKER_CONTAINER,
    frontendImage: e.RAILPACK_FRONTEND_IMAGE,
    memoryBudgetMb: e.MEMORY_BUDGET_MB,
    maxServiceMemoryMb: e.MAX_SERVICE_MEMORY_MB,
    buildTimeoutMs: e.BUILD_TIMEOUT_MINUTES * 60_000,
    drainSeconds: e.DRAIN_SECONDS,
    imageRetention: e.IMAGE_RETENTION,
    workDir: e.WORK_DIR,
    ...(e.GITHUB_TOKEN === undefined ? {} : { githubToken: e.GITHUB_TOKEN }),
  }
}
