# Plan 1 — Deploy Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้ VPS deploy แอปจาก GitHub repo ได้จริง ตั้งแต่ build ด้วย Railpack ไปจนถึงรัน container แบบไม่ล่ม และได้ URL HTTPS สั่งงานผ่าน CLI ของ worker (ยังไม่มี dashboard)

**Architecture:** monorepo TypeScript มี `@vpsm/core` (ฟังก์ชันล้วนและ type), `@vpsm/db` (Drizzle + Postgres, ใช้ตาราง `deployments` เป็นคิวงาน) และ `@vpsm/worker` (Node ตัวเดียวที่ถือ Docker socket) worker ดึงงานจากคิวทีละงาน → git clone → `railpack prepare` → `docker buildx build` ผ่าน railpack frontend → รัน container → healthcheck → เขียน route ให้ Traefik (file provider) → drain → หยุดตัวเก่า

**Tech Stack:** Node 24, pnpm workspaces, TypeScript (ESM), Vitest, Drizzle ORM + `postgres` (postgres.js), `dockerode`, `yaml`, `zod`, Docker Engine 29 + buildx, Railpack 0.43.0, Traefik v3.7, Postgres 18

**Spec:** [docs/superpowers/specs/2026-10-21-railway-like-paas-design.md](../specs/2026-10-21-railway-like-paas-design.md)

## แผนทั้งหมดของ v1 (spec ใหญ่เกินหนึ่งแผน เลยแบ่งเป็น 5 แผน แต่ละแผนได้ซอฟต์แวร์ที่ใช้งานได้)

1. **Deploy engine** — แผนนี้
2. **Web dashboard พื้นฐาน** — Next.js, ล็อกอิน admin/member, จัดการ user, project/service/สมาชิก, ปุ่ม deploy/rollback/restart, ตั้งค่าระบบ (ย้ายงบ RAM จาก env เข้าตาราง settings), audit events, route ของ panel
3. **GitHub App** — ติดตั้ง App, เลือก repo, webhook push → deploy, ใช้ installation token แทน `GITHUB_TOKEN`
4. **ตัวแปรและข้อมูล** — ตัวแปรเข้ารหัส + `${{…}}`, build secrets, Postgres/Redis template, public TCP, volume (deploy แบบหยุดก่อนเริ่ม), backup/restore + offsite, custom domain, เตือนเมื่อ disk ใกล้เต็ม
5. **Canvas และ log สด** — React Flow canvas, แผงข้าง, SSE log ทั้ง build และ runtime, สถานะสด

## Global Constraints

- เครื่องเป้าหมาย: VPS 1 เครื่อง, Ubuntu, 4 vCPU, RAM 8 GB
- TypeScript ทั้งระบบ, Node 24, ใช้ซอฟต์แวร์ open-source ฟรีเท่านั้น
- ติดตั้งด้วย `docker compose` ไฟล์เดียว + `.env`
- โดเมนตั้งผ่าน env (`APPS_DOMAIN`) ห้าม hardcode ห้ามใช้ชื่อ/โดเมน/แบรนด์ของ Railway ในโค้ด, label, ชื่อ container หรือข้อความ
- build ทีละงานเท่านั้น ทั้งเครื่อง
- ทุก container ของผู้ใช้ต้องมี memory limit, CPU limit, PID limit, `no-new-privileges`, ห้าม privileged, ห้าม mount Docker socket, ห้าม mount path ของ host
- worker เป็นตัวเดียวที่ถือ Docker socket และ **ห้ามเปิด port ใดๆ** (แผนนี้ให้ worker เข้าไปอยู่ใน network ของ project เพื่อทำ healthcheck ปลอดภัยได้เพราะ worker ไม่ listen อะไรเลย)
- ระบบห้ามพิมพ์ค่า secret (token, รหัสผ่าน) ลง log ใดๆ
- ตัวแปรที่ระบบ inject: `PORT` (ค่าเริ่มต้น 8080), `APP_SERVICE_NAME`, `APP_PROJECT_NAME`, `APP_PRIVATE_DOMAIN`, `APP_PUBLIC_DOMAIN`
- สถานะ deployment มีแค่: `QUEUED`, `BUILDING`, `DEPLOYING`, `SUCCESS`, `FAILED`, `CRASHED`, `REMOVED`, `SKIPPED`
- ค่าเริ่มต้น: memory 512 MB ต่อ service, CPU 1, เก็บ image ย้อนหลัง 5 ตัวต่อ service, drain 10 วินาที, build timeout 20 นาที, healthcheck timeout 300 วินาที, restart `on_failure` สูงสุด 10 ครั้ง
- งบ RAM รวมของแอปผู้ใช้ = `MEMORY_BUDGET_MB` (ค่าเริ่มต้น 5632 = 8192 − 2560), limit สูงสุดต่อ service = `MAX_SERVICE_MEMORY_MB` (ค่าเริ่มต้น 2048) เกินงบแล้วปฏิเสธทันที ไม่เข้าคิว
- Railpack CLI `0.43.0` และ frontend `ghcr.io/railwayapp/railpack-frontend:v0.43.0` ต้องเวอร์ชันเดียวกันเสมอ
- prefix ของทุกชื่อที่ระบบสร้างใน Docker: `vpsm-` (container, network, builder) และ `vpsm/` (image)

## Review Focus

1. **worker ตาย/ถูก restart กลาง deploy** → ผู้ใช้คาดว่า deployment ที่ค้างจะเป็น `FAILED` พร้อมเหตุผล ไม่มี container ค้าง และเว็บตัวที่ live อยู่ไม่ถูกแตะ → test ใน Task 9
2. **push สองครั้งติดกันเร็วๆ บน service เดียว** → ตัวที่ยังรอคิวกลายเป็น `SKIPPED` ตัวที่กำลังทำอยู่ทำต่อจนจบ ไม่มีสอง deploy ของ service เดียวรันพร้อมกัน → test ใน Task 3
3. **แอป listen ผิด port หรือไม่เคย healthy** → `FAILED` พร้อมเหตุผลว่า timeout หลังกี่วินาที เว็บเดิมยังตอบได้ container ใหม่ถูกลบ → test ใน Task 8
4. **memory เกินงบหรือเกิน limit ต่อ service** → ปฏิเสธก่อนเริ่ม build พร้อมบอกตัวเลข → test ใน Task 1 และ Task 8
5. **ชื่อ project/service ที่ใช้ไม่ได้** (ตัวใหญ่, ภาษาไทย, ช่องว่าง, ยาวเกิน, ลงท้ายด้วย `-`) และ `rootDirectory` ที่พยายามออกนอก repo (`../`) → ปฏิเสธพร้อมข้อความชัดเจน ไม่สร้างอะไรครึ่งๆ กลางๆ → test ใน Task 1, 3, 4

---

## File Structure

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.config.ts, .nvmrc, .env.example
docker-compose.yml                 # ระบบจริงบน VPS: postgres, traefik, worker
docker-compose.test.yml            # Postgres สำหรับ test (port 54329)
deploy/install-ubuntu.sh           # ติดตั้ง Docker + ufw บน VPS ใหม่
docs/operations.md                 # คู่มือติดตั้ง/อัปเดต/ทดสอบบน VPS
examples/hello-node/               # แอปตัวอย่าง ใช้ทั้ง integration test และ e2e
packages/core/src/
  names.ts                         # ตรวจชื่อ, hostname, ชื่อ container/network/image
  deployment-status.ts             # สถานะ + ตารางการเปลี่ยนสถานะ
  types.ts                         # SourceConfig, BuildConfig, DeployConfig + ค่าเริ่มต้น
  system-env.ts                    # ตัวแปรที่ระบบ inject
  memory-budget.ts                 # ตรวจงบ RAM
  index.ts
packages/db/src/
  schema.ts, client.ts, migrate.ts
  deployments.ts                   # คิว + สถานะ + log
  projects.ts                      # สร้าง project/service, โหลด context
  testing.ts                       # setupTestDb() สำหรับ test ทุก package
packages/db/migrations/            # สร้างด้วย drizzle-kit
apps/worker/src/
  config.ts                        # อ่าน env
  exec.ts                          # runCommand
  source/fetch-source.ts
  build/choose-builder.ts, build/railpack.ts, build/build-image.ts, build/errors.ts
  runtime/container-spec.ts, runtime/docker-runtime.ts, runtime/healthcheck.ts
  routing/traefik-config.ts, routing/active-routes.ts
  deploy/log-sink.ts, deploy/pipeline.ts, deploy/loop.ts, deploy/recovery.ts
  monitor/crash-monitor.ts
  images/retention.ts
  main.ts, cli.ts
apps/worker/Dockerfile
```

---

### Task 1: Monorepo + `@vpsm/core`

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`, `.nvmrc` (`24`), `packages/core/{package.json,tsconfig.json,vitest.config.ts}`
- Create: `packages/core/src/{names,deployment-status,types,system-env,memory-budget,index}.ts`
- Test: `packages/core/test/{names,deployment-status,system-env,memory-budget}.test.ts`

**Interfaces:**
- Produces:
  - `validateName(name: string): { ok: true } | { ok: false; reason: string }` (pattern `/^[a-z]([a-z0-9-]{0,28}[a-z0-9])?$/`)
  - `isValidHostname(h: string): boolean`
  - `generatedHostname(serviceName: string, projectName: string, appsDomain: string): string` → `` `${service}-${project}.${appsDomain}` ``
  - `privateHostname(serviceName: string): string` → `` `${serviceName}.internal` ``
  - `networkName(environmentId: string): string` → `` `vpsm-env-${environmentId}` ``
  - `containerName(serviceName: string, deploymentId: string): string` → `` `vpsm-${serviceName}-${deploymentId.slice(0, 8)}` ``
  - `imageTag(serviceInstanceId: string, deploymentId: string): string` → `` `vpsm/${serviceInstanceId}:${deploymentId}` ``
  - `DEPLOYMENT_STATUSES`, `type DeploymentStatus`, `canTransition(from: DeploymentStatus, to: DeploymentStatus): boolean`
  - `type SourceConfig = { repo: string; branch: string; rootDirectory?: string }`
  - `type BuildConfig = { builder: 'auto' | 'railpack' | 'dockerfile'; buildCommand?: string; dockerfilePath?: string }`
  - `type RestartPolicy = 'always' | 'on_failure' | 'never'`
  - `type DeployConfig = { startCommand?: string; healthcheckPath?: string; healthcheckTimeoutSec: number; restartPolicy: RestartPolicy; restartMaxRetries: number; memoryLimitMB: number; cpuLimit: number; port: number }`
  - `type DeploymentTrigger = 'push' | 'manual' | 'rollback' | 'config'`
  - `DEFAULT_BUILD_CONFIG = { builder: 'auto' }`, `DEFAULT_DEPLOY_CONFIG = { healthcheckTimeoutSec: 300, restartPolicy: 'on_failure', restartMaxRetries: 10, memoryLimitMB: 512, cpuLimit: 1, port: 8080 }`
  - `systemEnv(i: { port: number; serviceName: string; projectName: string; publicHostname?: string }): Record<string, string>`
  - `checkMemoryBudget(i: { runningMb: number[]; newMb: number; budgetMb: number; maxServiceMb: number }): { ok: true } | { ok: false; reason: string }`

- [ ] **Step 1: ตั้ง workspace**

`tsconfig.base.json`: `strict: true`, `module: ESNext`, `moduleResolution: Bundler`, `target: ES2023`, `noEmit: true` ทุก workspace package ตั้ง `"exports"` ชี้ไปไฟล์ `.ts` ใน `src/` โดยตรง (เช่น `{ ".": "./src/index.ts" }`) เพราะ worker ถูก bundle ด้วย tsup ใน Task 11 จึงไม่ต้อง build ทีละ package

root `package.json` (`"private": true`, `"type": "module"`, `packageManager` ใส่ด้วย `corepack use pnpm@latest`, scripts: `"test": "vitest run"`, `"test:int": "INTEGRATION=1 vitest run"`, `"typecheck": "pnpm -r exec tsc --noEmit"`, `"db:test:up": "docker compose -f docker-compose.test.yml up -d --wait"`), `pnpm-workspace.yaml` (`packages: ['packages/*', 'apps/*']`), root `vitest.config.ts` ใช้ `test.projects: ['packages/*', 'apps/*']` ทุก package มี `vitest.config.ts` ที่ include `test/**/*.int.test.ts` เมื่อมี `INTEGRATION=1` และ include `test/**/*.test.ts` (ไม่รวม `*.int.test.ts`) เมื่อไม่มี

Run: `corepack enable pnpm && corepack use pnpm@latest && pnpm install`
Expected: ติดตั้งสำเร็จ ไม่มี error

- [ ] **Step 2: เขียน test ที่ fail**

```ts
// packages/core/test/names.test.ts
test('validateName accepts lowercase names', () => {
  expect(validateName('web')).toEqual({ ok: true })
  expect(validateName('api-v2')).toEqual({ ok: true })
})
test.each(['Web', 'เว็บ', 'my app', 'web-', '-web', '1web', 'a'.repeat(31), ''])('validateName rejects %j', (n) => {
  expect(validateName(n).ok).toBe(false)
})
test('generatedHostname joins service and project', () => {
  expect(generatedHostname('web', 'shop', 'apps.example.com')).toBe('web-shop.apps.example.com')
})
test('longest valid names still make a valid DNS label', () => {
  const h = generatedHostname('a'.repeat(30), 'b'.repeat(30), 'apps.example.com')
  expect(isValidHostname(h)).toBe(true)
})
test('isValidHostname rejects rule-breaking input', () => {
  expect(isValidHostname('a`) || Host(`evil.com')).toBe(false)
  expect(isValidHostname('UPPER.example.com')).toBe(false)
})
test('docker names use vpsm prefix', () => {
  expect(containerName('web', '1234567890ab')).toBe('vpsm-web-12345678')
  expect(networkName('env1')).toBe('vpsm-env-env1')
  expect(imageTag('si1', 'd1')).toBe('vpsm/si1:d1')
  expect(privateHostname('api')).toBe('api.internal')
})

// packages/core/test/deployment-status.test.ts
test.each([
  ['QUEUED', 'BUILDING'], ['QUEUED', 'DEPLOYING'], ['QUEUED', 'SKIPPED'], ['QUEUED', 'FAILED'],
  ['BUILDING', 'DEPLOYING'], ['BUILDING', 'FAILED'], ['DEPLOYING', 'SUCCESS'], ['DEPLOYING', 'FAILED'],
  ['SUCCESS', 'REMOVED'], ['SUCCESS', 'CRASHED'], ['CRASHED', 'REMOVED'],
])('allows %s -> %s', (a, b) => expect(canTransition(a, b)).toBe(true))
test.each([['FAILED', 'SUCCESS'], ['REMOVED', 'SUCCESS'], ['SKIPPED', 'BUILDING'], ['SUCCESS', 'BUILDING'], ['BUILDING', 'SUCCESS']])(
  'rejects %s -> %s', (a, b) => expect(canTransition(a, b)).toBe(false))

// packages/core/test/system-env.test.ts
test('systemEnv without public hostname', () => {
  expect(systemEnv({ port: 8080, serviceName: 'api', projectName: 'shop' })).toEqual({
    PORT: '8080', APP_SERVICE_NAME: 'api', APP_PROJECT_NAME: 'shop', APP_PRIVATE_DOMAIN: 'api.internal',
  })
})
test('systemEnv with public hostname', () => {
  expect(systemEnv({ port: 3000, serviceName: 'web', projectName: 'shop', publicHostname: 'web-shop.apps.example.com' }).APP_PUBLIC_DOMAIN)
    .toBe('web-shop.apps.example.com')
})

// packages/core/test/memory-budget.test.ts
test('fits inside budget', () => {
  expect(checkMemoryBudget({ runningMb: [512, 512], newMb: 512, budgetMb: 5632, maxServiceMb: 2048 })).toEqual({ ok: true })
})
test('rejects when over per-service max', () => {
  expect(checkMemoryBudget({ runningMb: [], newMb: 4096, budgetMb: 5632, maxServiceMb: 2048 }))
    .toEqual({ ok: false, reason: 'memory limit 4096 MB exceeds per-service max 2048 MB' })
})
test('rejects when over total budget, counting overlap with old container', () => {
  expect(checkMemoryBudget({ runningMb: [2048, 2048, 1024], newMb: 1024, budgetMb: 5632, maxServiceMb: 2048 }))
    .toEqual({ ok: false, reason: 'memory budget exceeded: need 1024 MB, available 512 MB' })
})
```

- [ ] **Step 3: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project core`
Expected: FAIL (module/function not found)

- [ ] **Step 4: เขียนโค้ดใน `packages/core/src/*` ตาม Interfaces**

`isValidHostname`: ตัวเล็กเท่านั้น label ละ 1–63 ตัว (`a-z0-9-` ไม่ขึ้นต้นหรือลงท้ายด้วย `-`) อย่างน้อย 2 label รวมไม่เกิน 253 ตัว `canTransition` ใช้ตารางคงที่ที่มีเฉพาะคู่ใน test ฝั่ง allow `index.ts` re-export ทุกอย่าง

- [ ] **Step 5: Run test ให้ผ่าน**

Run: `pnpm vitest run --project core && pnpm typecheck`
Expected: PASS ทั้งหมด, typecheck ไม่มี error

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(core): workspace scaffold and core naming, status, budget helpers"
```

---

### Task 2: `@vpsm/db` schema, migration และ test harness

**Files:**
- Create: `docker-compose.test.yml`, `packages/db/{package.json,tsconfig.json,vitest.config.ts,drizzle.config.ts}`
- Create: `packages/db/src/{schema,client,migrate,testing,index}.ts`, `packages/db/migrations/*` (generate)
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Consumes: type จาก `@vpsm/core`
- Produces:
  - ตาราง (snake_case ใน DB, camelCase ใน TS) `id` ทุกตารางเป็น `uuid default gen_random_uuid()` ยกเว้น `deployment_logs.id` ที่เป็น `bigserial`
    - `projects(id, name unique, created_at)`
    - `environments(id, project_id → projects cascade, name, created_at, unique(project_id, name))`
    - `services(id, project_id → projects cascade, name, kind text check in ('app','postgres','redis') default 'app', canvas_x int default 0, canvas_y int default 0, created_at, unique(project_id, name))`
    - `service_instances(id, service_id → services cascade, environment_id → environments cascade, source jsonb SourceConfig null, build jsonb BuildConfig not null, deploy jsonb DeployConfig not null, created_at, unique(service_id, environment_id))`
    - `deployments(id, service_instance_id → service_instances cascade, status text not null default 'QUEUED', trigger text not null, commit_sha, commit_message, image_tag, container_name, rollback_of_id uuid → deployments null, config_snapshot jsonb, failure_reason, created_by_id uuid null, created_at, claimed_at, started_at, finished_at)` + index `(status, created_at)` และ `(service_instance_id, created_at desc)`
    - `deployment_logs(id bigserial, deployment_id → deployments cascade, phase text check in ('build','deploy'), ts timestamptz default now(), line text not null)` + index `(deployment_id, id)`
    - `domains(id, service_instance_id → service_instances cascade, hostname unique, kind text check in ('generated','custom'), created_at)`
  - type `Project`, `Environment`, `Service`, `ServiceInstance`, `Deployment`, `Domain` (Drizzle `$inferSelect`)
  - `createDb(url: string): { db: Db; sql: Sql; close(): Promise<void> }`
  - `migrate(url: string, migrationsFolder?: string): Promise<void>` — ค่าเริ่มต้นของ `migrationsFolder` = `process.env.MIGRATIONS_DIR` ถ้ามี ไม่งั้นเป็น `packages/db/migrations` (resolve จากตำแหน่งไฟล์ `migrate.ts`)
  - `@vpsm/db/testing`: `setupTestDb(): Promise<{ db: Db; sql: Sql; reset(): Promise<void>; close(): Promise<void> }>` ใช้ `TEST_DATABASE_URL` (ค่าเริ่มต้น `postgres://postgres:test@localhost:54329/postgres`), migrate ครั้งเดียวต่อ process, `reset()` = `TRUNCATE ... RESTART IDENTITY CASCADE` ทุกตาราง

- [ ] **Step 1: `docker-compose.test.yml`** — service `postgres` image `postgres:18`, `POSTGRES_PASSWORD=test`, port `54329:5432`, data บน `tmpfs`, healthcheck `pg_isready`

Run: `pnpm db:test:up`
Expected: container healthy

- [ ] **Step 2: เขียน test ที่ fail**

```ts
// packages/db/test/schema.test.ts
const t = await setupTestDb(); beforeEach(() => t.reset()); afterAll(() => t.close())
test('project names are unique', async () => {
  await t.db.insert(projects).values({ name: 'shop' })
  await expect(t.db.insert(projects).values({ name: 'shop' })).rejects.toThrow()
})
test('service names are unique per project but reusable across projects', async () => { /* insert shop/web, blog/web ok; shop/web twice rejects */ })
test('hostnames are globally unique', async () => { /* two domains same hostname rejects */ })
test('deleting a project cascades to deployments', async () => { /* build chain project→env→service→instance→deployment, delete project, deployments count 0 */ })
test('deployment status defaults to QUEUED', async () => { /* insert deployment with trigger 'manual'; status === 'QUEUED' */ })
```

- [ ] **Step 3: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project db`
Expected: FAIL (schema/testing ยังไม่มี)

- [ ] **Step 4: เขียน `schema.ts`, `client.ts`, `migrate.ts`, `testing.ts` แล้วสร้าง migration**

Run: `pnpm --filter @vpsm/db exec drizzle-kit generate --name init`
Expected: มีไฟล์ SQL ใหม่ใน `packages/db/migrations/`

- [ ] **Step 5: Run test ให้ผ่าน**

Run: `pnpm vitest run --project db`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(db): schema, migrations and test database harness"
```

---

### Task 3: คิว deployment, log และการสร้าง project/service

**Files:**
- Create: `packages/db/src/deployments.ts`, `packages/db/src/projects.ts`
- Test: `packages/db/test/deployments.test.ts`, `packages/db/test/projects.test.ts`

**Interfaces:**
- Consumes: Task 1 (`validateName`, `canTransition`, `generatedHostname`, defaults), Task 2 (tables, `Db`)
- Produces:
  - `DEPLOYMENTS_CHANNEL = 'vpsm_deployments_queued'`, `DEPLOYMENT_LOG_CHANNEL = 'vpsm_deployment_log'`
  - `class InvalidTransitionError extends Error`, `class ValidationError extends Error`
  - `enqueueDeployment(db, i: { serviceInstanceId: string; trigger: DeploymentTrigger; commitSha?: string; commitMessage?: string; rollbackOfId?: string; createdById?: string }): Promise<Deployment>` — ใน transaction เดียว: deployment ที่ `QUEUED` และ `claimed_at is null` ของ instance เดียวกันเป็น `SKIPPED` (`finished_at = now()`), insert ตัวใหม่, `pg_notify(DEPLOYMENTS_CHANNEL, id)`
  - `claimNextDeployment(db): Promise<Deployment | null>` — ตัว `QUEUED` ที่ `claimed_at is null` เก่าที่สุด ด้วย `FOR UPDATE SKIP LOCKED` ตั้ง `claimed_at = started_at = now()`
  - `setDeploymentStatus(db, id: string, to: DeploymentStatus, patch?: { failureReason?: string; commitSha?: string; commitMessage?: string; imageTag?: string; containerName?: string; configSnapshot?: unknown }): Promise<Deployment>` — อ่านแบบ `FOR UPDATE` ถ้า `canTransition` ไม่ได้ throw `InvalidTransitionError` ตั้ง `finished_at = now()` เมื่อ `to` เป็น `SUCCESS`, `FAILED` หรือ `SKIPPED`
  - `markDeploymentLive(db, i: { deploymentId: string; containerName: string; previousId?: string }): Promise<void>` — transaction: ตัวใหม่ `DEPLOYING → SUCCESS`, ตัวก่อน (`SUCCESS`/`CRASHED`) `→ REMOVED`
  - `appendDeploymentLogs(db, deploymentId: string, phase: 'build' | 'deploy', lines: string[]): Promise<void>` — bulk insert + `pg_notify(DEPLOYMENT_LOG_CHANNEL, deploymentId)`
  - `createProject(db, name: string): Promise<Project>` — ตรวจชื่อ (`ValidationError`), สร้าง environment `production` ใน transaction เดียวกัน
  - `createAppService(db, i: { projectName: string; serviceName: string; source: SourceConfig; build?: Partial<BuildConfig>; deploy?: Partial<DeployConfig>; appsDomain: string }): Promise<{ service: Service; instance: ServiceInstance; domain: Domain }>` — merge ค่าเริ่มต้น, สร้าง domain `generated` จาก `generatedHostname`, ทั้งหมดใน transaction เดียว
  - `type DeploymentContext = { deployment: Deployment; project: Project; environment: Environment; service: Service; instance: ServiceInstance; domains: Domain[]; previous: Deployment | null; rollbackSource: Deployment | null }`
  - `loadDeploymentContext(db, deploymentId: string): Promise<DeploymentContext>` — `previous` = deployment `SUCCESS` หรือ `CRASHED` ล่าสุดของ instance เดียวกัน (ไม่ใช่ตัวมันเอง)
  - `findServiceInstance(db, projectName: string, serviceName: string, environmentName = 'production'): Promise<{ project; environment; service; instance; domains } | null>`

- [ ] **Step 1: เขียน test ที่ fail**

```ts
// packages/db/test/deployments.test.ts  (fixture: createProject + createAppService ใน beforeEach)
test('enqueue skips older queued deployments of the same service', async () => {
  const a = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  const b = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  expect((await get(a.id)).status).toBe('SKIPPED')
  expect((await get(b.id)).status).toBe('QUEUED')
})
test('enqueue never skips a deployment that is already claimed', async () => {
  const a = await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  await claimNextDeployment(db)
  await enqueueDeployment(db, { serviceInstanceId, trigger: 'push' })
  expect((await get(a.id)).status).toBe('QUEUED')
})
test('claim is FIFO and returns null when empty', async () => {
  const a = await enqueueDeployment(db, { serviceInstanceId: si1, trigger: 'manual' })
  const b = await enqueueDeployment(db, { serviceInstanceId: si2, trigger: 'manual' })
  expect((await claimNextDeployment(db))!.id).toBe(a.id)
  expect((await claimNextDeployment(db))!.id).toBe(b.id)
  expect(await claimNextDeployment(db)).toBeNull()
})
test('setDeploymentStatus rejects illegal transitions', async () => {
  const d = await enqueueDeployment(db, { serviceInstanceId, trigger: 'manual' })
  await expect(setDeploymentStatus(db, d.id, 'SUCCESS')).rejects.toBeInstanceOf(InvalidTransitionError)
})
test('markDeploymentLive promotes new and removes previous', async () => { /* prev SUCCESS, new DEPLOYING → new SUCCESS, prev REMOVED */ })
test('appendDeploymentLogs stores lines in order', async () => { /* append ['a','b'] then ['c']; select by id order → a,b,c */ })

// packages/db/test/projects.test.ts
test('createProject creates production environment', async () => { /* environments for project = ['production'] */ })
test('createProject rejects invalid names and creates nothing', async () => {
  await expect(createProject(db, 'My Shop')).rejects.toBeInstanceOf(ValidationError)
  expect(await db.select().from(projects)).toHaveLength(0)
})
test('createAppService applies defaults and generated domain', async () => {
  const { instance, domain } = await createAppService(db, { projectName: 'shop', serviceName: 'web', source: { repo: 'acme/web', branch: 'main' }, appsDomain: 'apps.example.com' })
  expect(instance.deploy).toEqual(DEFAULT_DEPLOY_CONFIG)
  expect(domain).toMatchObject({ hostname: 'web-shop.apps.example.com', kind: 'generated' })
})
test('createAppService rejects duplicate service names', async () => { /* second call same names → throws ValidationError */ })
test('createAppService rejects a generated hostname that another service already uses', async () => {
  // project 'c' + service 'a-b' → a-b-c.apps.example.com ; project 'b-c' + service 'a' → same hostname
  await expect(createAppService(db, { projectName: 'b-c', serviceName: 'a', source, appsDomain: 'apps.example.com' }))
    .rejects.toThrow('hostname a-b-c.apps.example.com is already used by another service')
  expect(await servicesOf('b-c')).toHaveLength(0)
})
test('loadDeploymentContext returns previous live deployment', async () => { /* prev SUCCESS + new QUEUED → ctx.previous.id === prev.id */ })
```

- [ ] **Step 2: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project db`
Expected: FAIL ใน `deployments.test.ts` และ `projects.test.ts`

- [ ] **Step 3: เขียนโค้ดใน `deployments.ts` และ `projects.ts` ตาม Interfaces**

unique violation (`23505`) แปลงเป็น `ValidationError` ตาม constraint ที่ชน: ชื่อ service ซ้ำ → `'service "web" already exists in project "shop"'`, ชื่อ project ซ้ำ → `'project "shop" already exists'`, hostname ซ้ำ → `'hostname <hostname> is already used by another service'` ทั้งหมดอยู่ใน transaction จึงไม่เหลือข้อมูลครึ่งๆ กลางๆ

- [ ] **Step 4: Run test ให้ผ่าน**

Run: `pnpm vitest run --project db`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(db): deployment queue, status transitions, logs and project/service creation"
```

---

### Task 4: `runCommand` และการดึงโค้ด

**Files:**
- Create: `apps/worker/{package.json,tsconfig.json,vitest.config.ts}`, `apps/worker/src/exec.ts`, `apps/worker/src/source/fetch-source.ts`
- Test: `apps/worker/test/exec.test.ts`, `apps/worker/test/fetch-source.test.ts`

**Interfaces:**
- Produces:
  - `type LineHandler = (line: string, stream: 'stdout' | 'stderr') => void`
  - `type RunOptions = { cwd?: string; env?: Record<string, string>; timeoutMs?: number; onLine?: LineHandler; redact?: string[] }`
  - `type RunResult = { exitCode: number; timedOut: boolean }`
  - `type RunCommand = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>`
  - `runCommand: RunCommand` — `spawn` แยกบรรทัดตาม `\n`, แทนทุกค่าใน `redact` ด้วย `***` ก่อนส่งให้ `onLine`, env = `{ ...process.env, ...opts.env }`, timeout → SIGTERM แล้ว SIGKILL หลัง 5 วินาที คืน `{ exitCode: 124, timedOut: true }`
  - `class SourceError extends Error`
  - `githubCloneUrl(repo: string, token?: string): string` — `repo` ต้องตรง `/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/` ไม่งั้น `SourceError` มี token → `` `https://x-access-token:${token}@github.com/${repo}.git` `` ไม่มี → `` `https://github.com/${repo}.git` ``
  - `fetchSource(i: { cloneUrl: string; branch: string; commitSha?: string; rootDirectory?: string; destDir: string; onLine: LineHandler; redact: string[]; run?: RunCommand }): Promise<{ commitSha: string; commitMessage: string; contextDir: string }>`

- [ ] **Step 1: เขียน test ที่ fail**

```ts
// apps/worker/test/exec.test.ts
test('streams lines and returns exit code', async () => {
  const lines: string[] = []
  const r = await runCommand('node', ['-e', 'console.log("a\\nb"); process.exit(3)'], { onLine: (l) => lines.push(l) })
  expect(lines).toEqual(['a', 'b']); expect(r).toEqual({ exitCode: 3, timedOut: false })
})
test('redacts secrets before they reach onLine', async () => {
  const lines: string[] = []
  await runCommand('node', ['-e', 'console.log("token=s3cr3t")'], { onLine: (l) => lines.push(l), redact: ['s3cr3t'] })
  expect(lines).toEqual(['token=***'])
})
test('kills on timeout', async () => {
  expect(await runCommand('node', ['-e', 'setTimeout(()=>{}, 60000)'], { timeoutMs: 200 })).toEqual({ exitCode: 124, timedOut: true })
})

// apps/worker/test/fetch-source.test.ts  (beforeAll: สร้าง bare repo ชั่วคราวที่มี branch main, ไฟล์ app/index.js; cloneUrl = `file://${bare}`)
test('clones branch and reports commit', async () => {
  const r = await fetchSource({ cloneUrl, branch: 'main', destDir, onLine: () => {}, redact: [] })
  expect(r.commitSha).toBe(headSha); expect(r.commitMessage).toBe('initial'); expect(r.contextDir).toBe(destDir)
})
test('uses rootDirectory as context', async () => { /* rootDirectory 'app' → contextDir === join(destDir,'app') */ })
test('rejects rootDirectory outside the repo', async () => {
  await expect(fetchSource({ cloneUrl, branch: 'main', rootDirectory: '../..', destDir, onLine: () => {}, redact: [] }))
    .rejects.toThrow('rootDirectory escapes repository')
})
test('rejects missing rootDirectory', async () => { /* 'nope' → 'rootDirectory not found: nope' */ })
test('fails clearly on unknown branch', async () => { /* branch 'nope' → SourceError containing 'git clone failed' */ })
test('githubCloneUrl validates repo and embeds token', () => {
  expect(githubCloneUrl('acme/web', 't0k')).toBe('https://x-access-token:t0k@github.com/acme/web.git')
  expect(() => githubCloneUrl('acme/web; rm -rf /')).toThrow(SourceError)
})
```

- [ ] **Step 2: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project worker`
Expected: FAIL

- [ ] **Step 3: เขียน `exec.ts` และ `fetch-source.ts` ตาม Interfaces**

คำสั่ง git: `git clone --depth 1 --single-branch --branch <branch> <url> <dest>` → (ถ้ามี `commitSha`) `git -C <dest> fetch --depth 1 origin <sha>` + `git -C <dest> checkout --detach <sha>` → `git -C <dest> log -1 --format=%H%n%s` เก็บสองบรรทัดเป็น sha และ message, `rootDirectory` resolve แล้วต้องขึ้นต้นด้วย `destDir + path.sep` (หรือเท่ากับ `destDir`)

- [ ] **Step 4: Run test ให้ผ่าน**

Run: `pnpm vitest run --project worker`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): command runner with redaction and git source fetching"
```

---

### Task 5: Build image (Railpack / Dockerfile)

**Files:**
- Create: `apps/worker/src/build/{errors,choose-builder,railpack,build-image}.ts`
- Create: `examples/hello-node/{package.json,server.js}` — `start` = `node server.js`, listen `process.env.PORT`, `GET /health` → 200 `ok`, `GET /` → 200 `hello from vpsm`
- Test: `apps/worker/test/build.test.ts`, `apps/worker/test/build.int.test.ts`

**Interfaces:**
- Consumes: Task 4 (`RunCommand`, `LineHandler`), Task 1 (`BuildConfig`)
- Produces:
  - `class BuildError extends Error`
  - `chooseBuilder(contextDir: string, build: BuildConfig): Promise<'railpack' | 'dockerfile'>` — `dockerfilePath` ค่าเริ่มต้น `Dockerfile` ต้องอยู่ใน `contextDir`, `'dockerfile'` แต่หาไฟล์ไม่เจอ → `BuildError('Dockerfile not found at <path>')`
  - `railpackPrepare(i: { contextDir: string; outDir: string; build: BuildConfig; startCommand?: string; onLine: LineHandler; run?: RunCommand; sleep?: (ms: number) => Promise<void> }): Promise<{ planPath: string; infoPath: string }>`
  - `BUILDER_NAME = 'vpsm-builder'`
  - `ensureBuilder(run: RunCommand, onLine: LineHandler): Promise<void>`
  - `buildImage(i: { builder: 'railpack' | 'dockerfile'; contextDir: string; planPath?: string; dockerfilePath?: string; tag: string; cacheKey: string; frontendImage: string; timeoutMs: number; onLine: LineHandler; run?: RunCommand }): Promise<void>`

- [ ] **Step 1: เขียน test ที่ fail (ใช้ fake `run` ที่บันทึก args และคืน exit code ตามลำดับที่กำหนด)**

```ts
// apps/worker/test/build.test.ts
test('auto picks dockerfile when present, railpack otherwise', async () => { /* tmp dir with/without Dockerfile */ })
test('dockerfilePath outside context is rejected', async () => {
  await expect(chooseBuilder(dir, { builder: 'dockerfile', dockerfilePath: '../Dockerfile' })).rejects.toBeInstanceOf(BuildError)
})
test('railpackPrepare passes build and start commands as railpack env', async () => {
  const run = fakeRun([0])
  await railpackPrepare({ contextDir: '/src', outDir: '/out', build: { builder: 'auto', buildCommand: 'npm run build' }, startCommand: 'node server.js', onLine: () => {}, run })
  expect(run.calls[0]).toEqual(['railpack', ['prepare', '/src', '--plan-out', '/out/railpack-plan.json', '--info-out', '/out/railpack-info.json',
    '--env', 'RAILPACK_BUILD_CMD=npm run build', '--env', 'RAILPACK_START_CMD=node server.js']])
})
test('railpackPrepare retries exit 75 up to 3 attempts', async () => {
  const run = fakeRun([75, 75, 0]); const sleeps: number[] = []
  await railpackPrepare({ ...base, run, sleep: async (ms) => { sleeps.push(ms) } })
  expect(run.calls).toHaveLength(3); expect(sleeps).toEqual([2000, 4000])
})
test('railpackPrepare gives up after 3 transient failures', async () => {
  await expect(railpackPrepare({ ...base, run: fakeRun([75, 75, 75]), sleep: async () => {} })).rejects.toThrow('railpack prepare failed after 3 attempts')
})
test('railpackPrepare exit 1 fails at once with railpack messages', async () => {
  // fake run writes /out/railpack-info.json = {"success":false,"logs":[{"Level":"error","Msg":"No start command found"}]}
  await expect(railpackPrepare({ ...base, run })).rejects.toThrow('railpack could not plan this app: No start command found')
  expect(run.calls).toHaveLength(1)
})
test('buildImage uses railpack frontend through the vpsm builder', async () => {
  const run = fakeRun([0])
  await buildImage({ builder: 'railpack', contextDir: '/src', planPath: '/out/railpack-plan.json', tag: 'vpsm/si:d', cacheKey: 'si',
    frontendImage: 'ghcr.io/railwayapp/railpack-frontend:v0.43.0', timeoutMs: 1000, onLine: () => {}, run })
  expect(run.calls[0]).toEqual(['docker', ['buildx', 'build', '--builder', 'vpsm-builder', '--progress', 'plain', '--load', '-t', 'vpsm/si:d',
    '--build-arg', 'BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend:v0.43.0', '--build-arg', 'cache-key=si', '-f', '/out/railpack-plan.json', '/src']])
})
test('buildImage reports timeout in minutes', async () => {
  await expect(buildImage({ ...railpackArgs, timeoutMs: 20 * 60_000, run: fakeRunResult({ exitCode: 124, timedOut: true }) }))
    .rejects.toThrow('build timed out after 20 minutes')
})
test('ensureBuilder creates a capped docker-container builder only when missing', async () => {
  const run = fakeRun([1, 0])  // inspect fails → create
  await ensureBuilder(run, () => {})
  expect(run.calls[1]).toEqual(['docker', ['buildx', 'create', '--name', 'vpsm-builder', '--driver', 'docker-container',
    '--driver-opt', 'memory=3g', '--driver-opt', 'cpu-period=100000', '--driver-opt', 'cpu-quota=300000']])
})

// apps/worker/test/build.int.test.ts  (ต้องมี docker + railpack 0.43.0 ในเครื่อง)
test('builds examples/hello-node with railpack', async () => {
  // chooseBuilder → 'railpack'; ensureBuilder; railpackPrepare; buildImage(tag 'vpsm/int-test:1')
  // expect `docker image inspect vpsm/int-test:1` exit 0
}, 600_000)
```

- [ ] **Step 2: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project worker -t build`
Expected: FAIL

- [ ] **Step 3: เขียนโค้ดตาม Interfaces**

`railpackPrepare` exit อื่นที่ไม่ใช่ 0/1/75 → `BuildError('railpack prepare exited with code <n>')` / `buildImage` exit ไม่เป็น 0 → `BuildError('image build failed (exit code <n>)')` / dockerfile build ใช้ args เดียวกันแต่ไม่มี `--build-arg` สองตัวและ `-f <contextDir>/<dockerfilePath ?? 'Dockerfile'>`

- [ ] **Step 4: Run unit test ให้ผ่าน**

Run: `pnpm vitest run --project worker -t build`
Expected: PASS

- [ ] **Step 5: Run integration test (บนเครื่องที่มี Docker + railpack)**

Run: `curl -sSL https://railpack.com/install.sh | RAILPACK_VERSION=0.43.0 sh` แล้ว `railpack --version` (ต้องได้ `0.43.0`) แล้ว `INTEGRATION=1 pnpm vitest run --project worker build.int`
Expected: PASS และ `docker buildx inspect vpsm-builder` แสดง `Driver: docker-container`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(worker): railpack and dockerfile image builds with capped builder"
```

---

### Task 6: Docker runtime, container spec และ healthcheck

**Files:**
- Create: `apps/worker/src/runtime/{container-spec,docker-runtime,healthcheck}.ts`
- Test: `apps/worker/test/container-spec.test.ts`, `apps/worker/test/healthcheck.test.ts`, `apps/worker/test/docker-runtime.int.test.ts`

**Interfaces:**
- Consumes: Task 1 (`DeployConfig`)
- Produces:
  - label: `MANAGED_LABEL = 'vpsm.managed'`, `DEPLOYMENT_LABEL = 'vpsm.deployment-id'`, `INSTANCE_LABEL = 'vpsm.service-instance-id'`, `MEMORY_LABEL = 'vpsm.memory-mb'`
  - `buildContainerSpec(i: { name: string; image: string; env: Record<string, string>; deploy: DeployConfig; cmd?: string[]; networkName: string; aliases: string[]; deploymentId: string; serviceInstanceId: string }): Dockerode.ContainerCreateOptions`
  - `type ManagedContainer = { name: string; deploymentId: string; serviceInstanceId: string; memoryMb: number; running: boolean }`
  - `type ContainerState = { exists: boolean; running: boolean; restarting: boolean; exitCode: number; restartCount: number; restartPolicy: string; maxRetries: number }`
  - `interface DockerRuntime { ensureNetwork(name: string): Promise<void>; connect(containerName: string, networkName: string): Promise<void>; run(spec: Dockerode.ContainerCreateOptions): Promise<void>; state(name: string): Promise<ContainerState>; stopAndRemove(name: string, timeoutSec: number): Promise<void>; restart(name: string): Promise<void>; listManaged(): Promise<ManagedContainer[]>; imageExists(tag: string): Promise<boolean>; removeImage(tag: string): Promise<void>; onContainerDie(cb: (name: string) => void): () => void }`
    - `connect` และ `ensureNetwork` เรียกซ้ำได้ไม่ error, `stopAndRemove` ไม่ error ถ้าไม่มี container, `removeImage` เงียบเมื่อ image ไม่มีหรือถูกใช้อยู่, `onContainerDie` ฟังเฉพาะ container ที่มี `vpsm.managed=true`
  - `createDockerRuntime(docker?: Dockerode): DockerRuntime`
  - `type HealthMode = 'http' | 'tcp' | 'running'`
  - `healthMode(deploy: DeployConfig, hasDomain: boolean): HealthMode` — มี `healthcheckPath` → `http`; มีโดเมน → `tcp`; อื่นๆ → `running`
  - `waitHealthy(t: { host: string; port: number; path?: string; mode: HealthMode }, o: { timeoutMs: number; state: () => Promise<ContainerState>; intervalMs?: number; runningGraceMs?: number }): Promise<{ ok: true } | { ok: false; reason: string }>` — ค่าเริ่มต้น `intervalMs = 1000`, `runningGraceMs = 10000`, timeout ต่อ request 5 วินาที

- [ ] **Step 1: เขียน test ที่ fail**

```ts
// apps/worker/test/container-spec.test.ts
const spec = buildContainerSpec({ name: 'vpsm-web-12345678', image: 'vpsm/si:d', env: { PORT: '8080' }, deploy: DEFAULT_DEPLOY_CONFIG,
  networkName: 'vpsm-env-e1', aliases: ['web.internal'], deploymentId: 'd1', serviceInstanceId: 'si1' })
test('enforces resource limits', () => {
  expect(spec.HostConfig).toMatchObject({ Memory: 512 * 1024 * 1024, MemorySwap: 512 * 1024 * 1024, NanoCpus: 1e9, PidsLimit: 512 })
})
test('enforces security baseline', () => {
  expect(spec.HostConfig!.Privileged).toBe(false)
  expect(spec.HostConfig!.SecurityOpt).toContain('no-new-privileges:true')
  expect(spec.HostConfig!.CapDrop).toEqual(['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP', 'SETPCAP', 'SYS_CHROOT'])
  expect(spec.HostConfig!.Binds).toBeUndefined()
})
test('maps restart policy and log rotation', () => {
  expect(spec.HostConfig!.RestartPolicy).toEqual({ Name: 'on-failure', MaximumRetryCount: 10 })
  expect(spec.HostConfig!.LogConfig).toEqual({ Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } })
  expect(buildContainerSpec({ ...input, deploy: { ...DEFAULT_DEPLOY_CONFIG, restartPolicy: 'always' } }).HostConfig!.RestartPolicy).toEqual({ Name: 'unless-stopped' })
  expect(buildContainerSpec({ ...input, deploy: { ...DEFAULT_DEPLOY_CONFIG, restartPolicy: 'never' } }).HostConfig!.RestartPolicy).toEqual({ Name: 'no' })
})
test('labels, env, network alias', () => {
  expect(spec.Labels).toEqual({ 'vpsm.managed': 'true', 'vpsm.deployment-id': 'd1', 'vpsm.service-instance-id': 'si1', 'vpsm.memory-mb': '512' })
  expect(spec.Env).toEqual(['PORT=8080'])
  expect(spec.NetworkingConfig!.EndpointsConfig!['vpsm-env-e1'].Aliases).toEqual(['web.internal'])
})

// apps/worker/test/healthcheck.test.ts  (เปิด node:http / node:net server จริงบน 127.0.0.1 port สุ่ม)
const alive = async () => ({ ...baseState, running: true })
test('healthMode', () => {
  expect(healthMode({ ...DEFAULT_DEPLOY_CONFIG, healthcheckPath: '/health' }, false)).toBe('http')
  expect(healthMode(DEFAULT_DEPLOY_CONFIG, true)).toBe('tcp')
  expect(healthMode(DEFAULT_DEPLOY_CONFIG, false)).toBe('running')
})
test('http mode passes on 2xx', async () => { /* server /health → 200 ⇒ { ok: true } */ })
test('http mode keeps waiting through 503 then times out with reason', async () => {
  const r = await waitHealthy({ host: '127.0.0.1', port, path: '/health', mode: 'http' }, { timeoutMs: 1500, intervalMs: 100, state: alive })
  expect(r).toEqual({ ok: false, reason: expect.stringMatching(/^healthcheck timed out after 1s/) })
})
test('tcp mode passes when port accepts connections', async () => { /* net server ⇒ ok */ })
test('fails fast when container exits', async () => {
  const r = await waitHealthy({ host: '127.0.0.1', port: 1, mode: 'tcp' }, { timeoutMs: 60_000, intervalMs: 50,
    state: async () => ({ ...baseState, running: false, exitCode: 137 }) })
  expect(r).toEqual({ ok: false, reason: 'container exited with code 137' })
})
test('running mode needs the grace period', async () => {
  expect(await waitHealthy({ host: 'x', port: 0, mode: 'running' }, { timeoutMs: 5000, runningGraceMs: 200, intervalMs: 50, state: alive })).toEqual({ ok: true })
})

// apps/worker/test/docker-runtime.int.test.ts  (Docker จริง, ชื่อทุกอย่างขึ้นต้น vpsm-int-)
test('run, state, listManaged, stopAndRemove round trip', async () => { /* run alpine sleep 60 with labels → listManaged contains → stopAndRemove → state.exists false */ })
test('ensureNetwork and connect are idempotent', async () => { /* call twice each, no throw */ })
```

- [ ] **Step 2: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project worker -t "spec|health"`
Expected: FAIL

- [ ] **Step 3: เขียนโค้ดตาม Interfaces**

`cmd` มีค่าจึงใส่ `Cmd`, `Env` เป็น `KEY=VALUE` เรียงตาม key, ข้อความ timeout = `` `healthcheck timed out after ${Math.round(timeoutMs / 1000)}s` `` ต่อด้วย `` ` (last error: ${msg})` `` เมื่อมี error ครั้งสุดท้าย

- [ ] **Step 4: Run test ให้ผ่าน (unit + integration)**

Run: `pnpm vitest run --project worker && INTEGRATION=1 pnpm vitest run --project worker docker-runtime.int`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): hardened container spec, docker runtime and healthchecks"
```

---

### Task 7: Route ของ Traefik

**Files:**
- Create: `apps/worker/src/routing/{traefik-config,active-routes}.ts`
- Test: `apps/worker/test/traefik-config.test.ts`, `apps/worker/test/active-routes.test.ts`

**Interfaces:**
- Consumes: Task 1 (`isValidHostname`), Task 2/3 (tables)
- Produces:
  - `type Route = { serviceInstanceId: string; hostnames: string[]; upstreamUrl: string }`
  - `renderRoutesYaml(routes: Route[]): string`
  - `writeRoutesFile(dir: string, yaml: string): Promise<void>` — เขียน `routes.yml.tmp` แล้ว `rename` เป็น `routes.yml`
  - `loadActiveRoutes(db: Db): Promise<Route[]>` — deployment `SUCCESS` ที่มี `container_name` + domains ของ instance นั้น, `upstreamUrl` = `` `http://${containerName}:${configSnapshot.deploy.port}` ``, ข้าม instance ที่ไม่มีโดเมน, เรียงตาม `serviceInstanceId`
  - `regenerateRoutes(db: Db, dir: string): Promise<void>` = load → render → write
- ไม่ใช้ Traefik API (เปิด API แล้ว container ผู้ใช้ใน network เดียวกับ Traefik จะอ่าน route ของทุก project ได้) หลังเขียนไฟล์ pipeline รอ 3 วินาทีแทน (Traefik file provider reload ภายใน ~2 วินาที)

- [ ] **Step 1: เขียน test ที่ fail**

```ts
// apps/worker/test/traefik-config.test.ts
test('renders router and service per instance', () => {
  expect(renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames: ['web-shop.apps.example.com'], upstreamUrl: 'http://vpsm-web-12345678:8080' }])).toBe(
`http:
  routers:
    r-si1:
      rule: Host(\`web-shop.apps.example.com\`)
      entryPoints:
        - websecure
      service: s-si1
      tls:
        certResolver: le
  services:
    s-si1:
      loadBalancer:
        servers:
          - url: http://vpsm-web-12345678:8080
`)
})
test('multiple hostnames are OR-ed in sorted order', () => {
  expect(renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames: ['b.example.com', 'a.example.com'], upstreamUrl: 'http://x:1' }]))
    .toContain('rule: Host(`a.example.com`) || Host(`b.example.com`)')
})
test('empty route list is still valid config', () => {
  expect(renderRoutesYaml([])).toBe('http:\n  routers: {}\n  services: {}\n')
})
test('refuses hostnames that could inject Traefik rules', () => {
  expect(() => renderRoutesYaml([{ serviceInstanceId: 'si1', hostnames: ['a`) || Host(`evil.com'], upstreamUrl: 'http://x:1' }])).toThrow('invalid hostname')
})
test('writeRoutesFile replaces atomically and leaves no tmp file', async () => { /* write twice; readdir === ['routes.yml']; content === second */ })

// apps/worker/test/active-routes.test.ts  (test DB)
test('only live deployments with domains are routed', async () => {
  // si1: SUCCESS container vpsm-web-aaaaaaaa, port 3000 in configSnapshot, domain web-shop… → routed
  // si2: FAILED only → not routed;  si3: SUCCESS but no domains → not routed
  expect(await loadActiveRoutes(db)).toEqual([{ serviceInstanceId: si1, hostnames: ['web-shop.apps.example.com'], upstreamUrl: 'http://vpsm-web-aaaaaaaa:3000' }])
})
```

- [ ] **Step 2: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project worker -t "routes|Routes"`
Expected: FAIL

- [ ] **Step 3: เขียนโค้ดตาม Interfaces** (ใช้ package `yaml` ให้ output ตรงกับ test)

- [ ] **Step 4: Run test ให้ผ่าน**

Run: `pnpm vitest run --project worker`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): traefik file-provider routes from live deployments"
```

---

### Task 8: Deploy pipeline

**Files:**
- Create: `apps/worker/src/config.ts`, `apps/worker/src/deploy/{log-sink,pipeline}.ts`
- Test: `apps/worker/test/fakes.ts`, `apps/worker/test/config.test.ts`, `apps/worker/test/pipeline.test.ts`

**Interfaces:**
- Consumes: Task 1, 3, 4, 5, 6, 7 ทั้งหมด
- Produces:
  - `type WorkerConfig = { appsDomain: string; traefikDynamicDir: string; traefikContainer: string; workerContainer: string; frontendImage: string; memoryBudgetMb: number; maxServiceMemoryMb: number; buildTimeoutMs: number; drainSeconds: number; imageRetention: number; workDir: string; githubToken?: string }`
  - `loadConfig(env?: NodeJS.ProcessEnv): WorkerConfig` (zod) — env และค่าเริ่มต้น: `APPS_DOMAIN` (บังคับ, ต้องผ่าน `isValidHostname`), `TRAEFIK_DYNAMIC_DIR=/traefik/dynamic`, `TRAEFIK_CONTAINER=vpsm-traefik`, `WORKER_CONTAINER=vpsm-worker`, `RAILPACK_FRONTEND_IMAGE=ghcr.io/railwayapp/railpack-frontend:v0.43.0`, `MEMORY_BUDGET_MB=5632`, `MAX_SERVICE_MEMORY_MB=2048`, `BUILD_TIMEOUT_MINUTES=20`, `DRAIN_SECONDS=10`, `IMAGE_RETENTION=5`, `WORK_DIR=/var/lib/vpsm/work`, `GITHUB_TOKEN` (ไม่บังคับ)
  - `createLogSink(db: Db, deploymentId: string): { line(phase: 'build' | 'deploy', text: string): void; close(): Promise<void> }` — flush เมื่อครบ 100 บรรทัดหรือทุก 250 ms
  - `type PipelineDeps = { db: Db; docker: DockerRuntime; config: WorkerConfig; run: RunCommand; sleep: (ms: number) => Promise<void>; fetchSource: typeof fetchSource; chooseBuilder: typeof chooseBuilder; railpackPrepare: typeof railpackPrepare; buildImage: typeof buildImage; waitHealthy: typeof waitHealthy; regenerateRoutes: () => Promise<void>; cleanupImages: (serviceInstanceId: string) => Promise<void> }`
  - `runDeployment(deploymentId: string, deps: PipelineDeps): Promise<void>` — ไม่ throw ทุก error กลายเป็น `FAILED`

**ลำดับใน `runDeployment` (จาก spec §5.3):**
1. `ctx = loadDeploymentContext`; เปิด log sink
2. งบ RAM: `checkMemoryBudget({ runningMb: listManaged().filter(running).map(memoryMb), newMb: deploy.memoryLimitMB, budgetMb, maxServiceMb })` ไม่ผ่าน → `FAILED` ด้วย `reason` ทันที (ยังไม่ clone)
3. `trigger === 'rollback'`: ใช้ `imageTag` และ `configSnapshot` ของ `rollbackSource` ถ้า `!imageExists(tag)` → `FAILED('image for rollback target no longer exists')` → `QUEUED → DEPLOYING` ข้ามไปขั้น 5
4. `BUILDING`: `fetchSource` (cloneUrl = `githubCloneUrl(source.repo, githubToken)`, `redact = [githubToken]`) ลง `${workDir}/${deploymentId}/src` → `chooseBuilder` → (railpack) `railpackPrepare` ลง `${workDir}/${deploymentId}` → `buildImage` (tag = `imageTag(instance.id, deployment.id)`, `cacheKey = instance.id`) → `BUILDING → DEPLOYING` พร้อม `commitSha`, `commitMessage`, `imageTag`, `configSnapshot = { source, build, deploy }`
5. `DEPLOYING`: `ensureNetwork(networkName(environment.id))` → `connect(traefikContainer, net)` + `connect(workerContainer, net)` → env = `systemEnv(...)` (`publicHostname` = โดเมนแรกเรียงตามตัวอักษร) → `cmd = builder === 'dockerfile' && startCommand ? ['sh', '-c', startCommand] : undefined` (railpack ฝัง start command ลง image แล้ว) → `run(buildContainerSpec({ name: containerName(service.name, deployment.id), aliases: [privateHostname(service.name)], ... }))`
6. `waitHealthy({ host: name, port: deploy.port, path: deploy.healthcheckPath, mode: healthMode(deploy, domains.length > 0) }, { timeoutMs: healthcheckTimeoutSec * 1000, state: () => docker.state(name) })` ไม่ผ่าน → `stopAndRemove(name, 0)` → `FAILED(reason)`
7. ผ่าน → `markDeploymentLive({ deploymentId, containerName: name, previousId: previous?.id })` → `regenerateRoutes()` → ถ้ามี `previous`: `sleep(3000)` แล้ว `sleep(drainSeconds * 1000)` แล้ว `stopAndRemove(previous.containerName, 30)` → `cleanupImages(instance.id)`
8. `finally`: ลบ `${workDir}/${deploymentId}` ทั้งโฟลเดอร์ แล้ว `sink.close()`
- error ที่เป็น `SourceError`/`BuildError` → reason = `message`; อื่นๆ → `` `internal error: ${message}` `` และถ้าสร้าง container ใหม่ไปแล้วให้ `stopAndRemove` ทิ้ง
- log ขึ้นต้นแต่ละขั้นด้วย `==> ` เช่น `==> Cloning acme/web@main`, `==> Building with railpack`, `==> Starting container`, `==> Healthcheck (http /health)`, `==> Live at https://web-shop.apps.example.com`

- [ ] **Step 1: เขียน `test/fakes.ts`**
  - `FakeDocker implements DockerRuntime` เก็บ container ใน `Map` มี helper `has(name): boolean`, `lastSpec(): ContainerCreateOptions`, `seedRunning(list: { memoryMb: number }[])`, `setState(name, partial)`, `emitDie(name)`, `existingImages: Set<string>` (`run` ใส่ tag ของ image ที่ใช้ลง set ด้วย)
  - `fakeDeps(overrides?)` ใช้ test DB จริงจาก `@vpsm/db/testing` + fake ทุก dependency อื่น ทุกตัวบันทึกลง `events: string[]` เดียวกันด้วยชื่อตายตัว: `'fetch'`, `'build'` (นับเฉพาะ `buildImage`), `` `run ${name}` ``, `'health'`, `'routes'`, `` `sleep ${ms}` ``, `` `stop ${name}` ``, `'cleanup'`
  - ค่าเริ่มต้นของ fake: `fetchSource` คืน sha `abc123` และ message `test commit`, `chooseBuilder` คืน `'railpack'`, `waitHealthy` คืน `{ ok: true }`

- [ ] **Step 2: เขียน test ที่ fail**

```ts
// apps/worker/test/config.test.ts
test('defaults and required APPS_DOMAIN', () => {
  expect(loadConfig({ APPS_DOMAIN: 'apps.example.com' })).toMatchObject({ memoryBudgetMb: 5632, maxServiceMemoryMb: 2048, buildTimeoutMs: 1_200_000,
    drainSeconds: 10, imageRetention: 5, frontendImage: 'ghcr.io/railwayapp/railpack-frontend:v0.43.0' })
  expect(() => loadConfig({})).toThrow(/APPS_DOMAIN/)
})

// apps/worker/test/pipeline.test.ts  (test DB + fakes)
test('first deploy goes QUEUED → BUILDING → DEPLOYING → SUCCESS and routes', async () => {
  await runDeployment(d.id, deps)
  expect(await statusHistory(d.id)).toEqual(['QUEUED', 'BUILDING', 'DEPLOYING', 'SUCCESS'])  // บันทึกผ่าน spy บน setDeploymentStatus/markDeploymentLive
  expect(deps.events).toEqual(['fetch', 'build', 'run vpsm-web-' + d.id.slice(0, 8), 'health', 'routes', 'cleanup'])
})
test('redeploy switches routes before stopping the old container', async () => {
  // previous SUCCESS with container vpsm-web-old00000 running in FakeDocker
  await runDeployment(d2.id, deps)
  const e = deps.events
  expect(e.indexOf('routes')).toBeLessThan(e.indexOf('stop vpsm-web-old00000'))
  expect(e).toContain('sleep 3000'); expect(e).toContain('sleep 10000')
  expect((await get(previous.id)).status).toBe('REMOVED')
})
test('unhealthy app fails, old container keeps serving, new container removed', async () => {
  deps.waitHealthy = async () => ({ ok: false, reason: 'healthcheck timed out after 300s (last error: ECONNREFUSED)' })
  await runDeployment(d2.id, deps)
  expect(await get(d2.id)).toMatchObject({ status: 'FAILED', failureReason: 'healthcheck timed out after 300s (last error: ECONNREFUSED)' })
  expect((await get(previous.id)).status).toBe('SUCCESS')
  expect(deps.events).not.toContain('routes')
  expect(deps.docker.has('vpsm-web-old00000')).toBe(true); expect(deps.docker.has(newName)).toBe(false)
})
test('build failure stops before any container is created', async () => {
  deps.buildImage = async () => { throw new BuildError('image build failed (exit code 1)') }
  await runDeployment(d.id, deps)
  expect(await get(d.id)).toMatchObject({ status: 'FAILED', failureReason: 'image build failed (exit code 1)' })
  expect(deps.events.some((e) => e.startsWith('run '))).toBe(false)
})
test('memory budget is checked before cloning', async () => {
  deps.docker.seedRunning([{ memoryMb: 2048 }, { memoryMb: 2048 }, { memoryMb: 1280 }])
  await runDeployment(d.id, deps)
  expect(await get(d.id)).toMatchObject({ status: 'FAILED', failureReason: 'memory budget exceeded: need 512 MB, available 256 MB' })
  expect(deps.events).not.toContain('fetch')
})
test('rollback reuses the old image without building', async () => {
  // rollbackSource SUCCESS→REMOVED earlier with imageTag vpsm/si:old; FakeDocker.existingImages has it
  await runDeployment(rb.id, deps)
  expect(deps.events).not.toContain('build'); expect(deps.events).not.toContain('fetch')
  expect(deps.docker.lastSpec().Image).toBe('vpsm/si:old')
  expect((await get(rb.id)).status).toBe('SUCCESS')
})
test('rollback fails clearly when image was cleaned up', async () => { /* existingImages empty → FAILED 'image for rollback target no longer exists' */ })
test('work directory is removed after success and after failure', async () => { /* existsSync(`${workDir}/${id}`) false in both cases */ })
test('github token never reaches the deployment log', async () => {
  // config.githubToken = 'ghs_secret'; fake fetchSource calls onLine with a line containing the clone URL
  await runDeployment(d.id, deps)
  expect((await logLines(d.id)).join('\n')).not.toContain('ghs_secret')
})
```

- [ ] **Step 3: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project worker -t "pipeline|config|deploy"`
Expected: FAIL

- [ ] **Step 4: เขียน `config.ts`, `log-sink.ts`, `pipeline.ts` ตามลำดับข้างบน**

- [ ] **Step 5: Run test ให้ผ่าน**

Run: `pnpm vitest run --project worker`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(worker): zero-downtime deploy pipeline with budget check and rollback"
```

---

### Task 9: Worker loop, กู้งานค้าง, จับ crash, ลบ image เก่า

**Files:**
- Create: `apps/worker/src/deploy/{loop,recovery}.ts`, `apps/worker/src/monitor/crash-monitor.ts`, `apps/worker/src/images/retention.ts`, `apps/worker/src/main.ts`
- Test: `apps/worker/test/{loop,recovery,crash-monitor,retention}.test.ts`

**Interfaces:**
- Consumes: Task 3 (`claimNextDeployment`, `setDeploymentStatus`, `DEPLOYMENTS_CHANNEL`), Task 6 (`DockerRuntime`), Task 7 (`regenerateRoutes`), Task 8 (`runDeployment`, `PipelineDeps`)
- Produces:
  - `startDeployLoop(deps: PipelineDeps & { listen: (channel: string, onNotify: () => void) => Promise<() => Promise<void>> }, signal: AbortSignal): Promise<void>` — ทำงานเมื่อเริ่ม, เมื่อได้ notify และทุก 5 วินาที, วน `claimNextDeployment` → `runDeployment` จนคิวว่าง ทีละงานเสมอ (มี flag กันการวนซ้อน)
  - `recoverInterruptedDeployments(deps: PipelineDeps): Promise<{ failed: number; removedContainers: number }>` — `BUILDING`, `DEPLOYING` และ `QUEUED` ที่ `claimed_at` ไม่ว่าง → `FAILED('worker restarted during deployment')`; container ที่ managed แต่ deployment ไม่ใช่ `SUCCESS`/`CRASHED` → `stopAndRemove(name, 0)`; แล้ว `regenerateRoutes()`
  - `isCrashFinal(s: ContainerState): boolean` — `!running && !restarting && (restartPolicy === 'no' || (restartPolicy === 'on-failure' && restartCount >= maxRetries))`
  - `startCrashMonitor(deps: PipelineDeps, signal: AbortSignal): void` — `onContainerDie` → รอ 2 วินาที → `state` → ถ้า `isCrashFinal` และ deployment ของ container เป็น `SUCCESS` → `CRASHED` พร้อม `` `container exited with code ${exitCode}` ``
  - `cleanupImages(deps: { db: Db; docker: DockerRuntime; config: WorkerConfig }, serviceInstanceId: string): Promise<string[]>` — คืนรายการ tag ที่ลบ เก็บ `imageRetention` tag ล่าสุด และไม่ลบ tag ของ deployment ที่ `SUCCESS`/`CRASHED` เด็ดขาด
  - `main.ts`: `migrate` → `loadConfig` → `createDb` → `createDockerRuntime` → `ensureBuilder` → `recoverInterruptedDeployments` → `startCrashMonitor` → `startDeployLoop` / SIGTERM → abort แล้ว `close()` DB

- [ ] **Step 1: เขียน test ที่ fail**

```ts
// recovery.test.ts
test('interrupted deployments become FAILED and orphans are removed, live one untouched', async () => {
  // DB: live SUCCESS (container vpsm-web-live0000), BUILDING b1, DEPLOYING d1 (container vpsm-web-d1000000 in FakeDocker), QUEUED+claimed q1, QUEUED unclaimed q2
  expect(await recoverInterruptedDeployments(deps)).toEqual({ failed: 3, removedContainers: 1 })
  expect((await get(b1)).failureReason).toBe('worker restarted during deployment')
  expect((await get(q2)).status).toBe('QUEUED')
  expect(deps.docker.has('vpsm-web-live0000')).toBe(true)
  expect(deps.events).toContain('routes')
})
// loop.test.ts
test('processes queued deployments one at a time in order', async () => {
  // runDeployment fake records start/end with a 50ms delay; enqueue 3 → order start1,end1,start2,end2,start3,end3
})
test('wakes up on notify', async () => { /* loop idle, enqueue + trigger listen callback → runDeployment called within 200ms */ })
// crash-monitor.test.ts
test.each([
  [{ running: false, restarting: false, restartPolicy: 'on-failure', restartCount: 10, maxRetries: 10 }, true],
  [{ running: false, restarting: false, restartPolicy: 'on-failure', restartCount: 3, maxRetries: 10 }, false],
  [{ running: false, restarting: true, restartPolicy: 'on-failure', restartCount: 3, maxRetries: 10 }, false],
  [{ running: false, restarting: false, restartPolicy: 'no', restartCount: 0, maxRetries: 0 }, true],
  [{ running: false, restarting: false, restartPolicy: 'unless-stopped', restartCount: 50, maxRetries: 0 }, false],
])('isCrashFinal %j', (s, expected) => expect(isCrashFinal({ exists: true, exitCode: 1, ...s })).toBe(expected))
test('final crash marks live deployment CRASHED', async () => { /* FakeDocker emits die for live container with final state exitCode 1 → status CRASHED, reason 'container exited with code 1' */ })
// retention.test.ts
test('keeps newest 5 tags plus the live one', async () => {
  // 8 deployments with tags t1..t8 (t1 oldest), t2 is SUCCESS → removed = ['vpsm/si:t1','vpsm/si:t3']
})
```

- [ ] **Step 2: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project worker -t "recover|loop|crash|retention|keeps"`
Expected: FAIL

- [ ] **Step 3: เขียนโค้ดตาม Interfaces** (`listen` ใน `main.ts` ใช้ `sql.listen(DEPLOYMENTS_CHANNEL, cb)` ของ postgres.js)

- [ ] **Step 4: Run test ให้ผ่าน**

Run: `pnpm vitest run --project worker`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): deploy loop, crash recovery, crash monitor and image retention"
```

---

### Task 10: CLI สำหรับผู้ดูแล

**Files:**
- Create: `apps/worker/src/cli.ts`
- Test: `apps/worker/test/cli.test.ts`

**Interfaces:**
- Consumes: Task 3 (`createProject`, `createAppService`, `findServiceInstance`, `enqueueDeployment`), Task 6 (`DockerRuntime.restart`)
- Produces: `runCli(argv: string[], deps: { db: Db; docker: DockerRuntime; config: WorkerConfig; out: (line: string) => void }): Promise<number>` (คืน exit code) — parse ด้วย `node:util` `parseArgs` คำสั่ง:
  - `project:create <project>`
  - `service:create <project> <service> --repo <owner/name> --branch <branch> [--root <dir>] [--healthcheck <path>] [--port <n>] [--memory <mb>] [--start <cmd>]` → สร้างแล้ว enqueue deploy `manual` ทันที พิมพ์ URL
  - `deploy <project> <service>` → enqueue `manual`
  - `rollback <project> <service> <deploymentId>` → enqueue `rollback` (`rollbackOfId`) ต้องเป็น deployment ของ service เดียวกันที่มี `imageTag`
  - `restart <project> <service>` → `docker.restart(containerName ของ SUCCESS)`
  - `status <project>` → บรรทัดละ service: `<service>  <status ล่าสุด>  <https://hostname หรือ ->`
  - `logs <deploymentId>` → พิมพ์ log เรียงตาม id
  - error (`ValidationError`, ไม่พบ project/service) → พิมพ์ `error: <message>` คืน 1
- Entrypoint: ถ้า `import.meta.url` เป็นไฟล์ที่รันตรง ให้สร้าง deps จริงแล้ว `process.exit(await runCli(process.argv.slice(2), deps))`

- [ ] **Step 1: เขียน test ที่ fail**

```ts
test('service:create creates, enqueues and prints the URL', async () => {
  await runCli(['project:create', 'shop'], deps)
  expect(await runCli(['service:create', 'shop', 'web', '--repo', 'acme/web', '--branch', 'main', '--memory', '256'], deps)).toBe(0)
  expect(out).toContain('https://web-shop.apps.example.com')
  expect((await deploymentsOf('shop', 'web'))[0]).toMatchObject({ status: 'QUEUED', trigger: 'manual' })
  expect((await instanceOf('shop', 'web')).deploy.memoryLimitMB).toBe(256)
})
test('invalid names return exit 1 with message', async () => {
  expect(await runCli(['project:create', 'My Shop'], deps)).toBe(1)
  expect(out.at(-1)).toMatch(/^error: /)
})
test('rollback refuses a deployment from another service', async () => { /* exit 1, 'error: deployment does not belong to shop/web' */ })
test('status lists services with latest status and URL', async () => { /* 'web  SUCCESS  https://web-shop.apps.example.com' */ })
```

- [ ] **Step 2: Run test ให้เห็นว่า fail**

Run: `pnpm vitest run --project worker -t cli`
Expected: FAIL

- [ ] **Step 3: เขียน `cli.ts` ตาม Interfaces**

- [ ] **Step 4: Run test ให้ผ่าน**

Run: `pnpm vitest run --project worker`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(worker): operator CLI for projects, services, deploys and rollbacks"
```

---

### Task 11: ติดตั้งบน VPS และทดสอบตั้งแต่ต้นจนจบ

**Files:**
- Create: `apps/worker/tsup.config.ts`, `apps/worker/Dockerfile`, `docker-compose.yml`, `.env.example`, `deploy/install-ubuntu.sh`, `docs/operations.md`
- Modify: `apps/worker/package.json` (เพิ่ม script `"build": "tsup"`)

**รายละเอียดที่ล็อกไว้:**
- `apps/worker/tsup.config.ts`: entry `src/main.ts`, `src/cli.ts`, format `esm`, target `node24`, outDir `dist`, `noExternal: [/^@vpsm\//]` (bundle `@vpsm/core` และ `@vpsm/db` เข้าไป ส่วน dependency อื่นเป็น external)
- `apps/worker/Dockerfile`: stage build ใช้ `node:24-bookworm-slim` → `pnpm install --frozen-lockfile` → `pnpm --filter @vpsm/worker build` → `pnpm deploy --filter @vpsm/worker --prod /out` / stage runtime `node:24-bookworm-slim` + `git`, `ca-certificates`, `curl`; copy `/out` (มี `node_modules`) + `apps/worker/dist` ไป `/app`, copy `packages/db/migrations` ไป `/app/migrations` และตั้ง `ENV MIGRATIONS_DIR=/app/migrations`; `COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker` และ `/usr/local/libexec/docker/cli-plugins/docker-buildx`; ติดตั้ง railpack จาก `https://github.com/railwayapp/railpack/releases/download/v0.43.0/railpack-v0.43.0-x86_64-unknown-linux-musl.tar.gz` ลง `/usr/local/bin`; `CMD ["node", "dist/main.js"]`
- `docker-compose.yml` (ทุก service `restart: unless-stopped`):
  - `postgres`: `postgres:18`, volume `vpsm-pgdata`, `mem_limit: 512m`, healthcheck `pg_isready`, network `control`
  - `traefik`: `traefik:v3.7`, `container_name: vpsm-traefik`, ports `80:80`, `443:443`, `mem_limit: 256m`, volumes `vpsm-acme:/acme`, `vpsm-traefik-dynamic:/traefik/dynamic:ro`, command:
    `--providers.file.directory=/traefik/dynamic`, `--providers.file.watch=true`, `--entrypoints.web.address=:80`, `--entrypoints.web.http.redirections.entrypoint.to=websecure`, `--entrypoints.web.http.redirections.entrypoint.scheme=https`, `--entrypoints.websecure.address=:443`, `--certificatesresolvers.le.acme.email=${ACME_EMAIL}`, `--certificatesresolvers.le.acme.storage=/acme/acme.json`, `--certificatesresolvers.le.acme.httpchallenge.entrypoint=web`, `--log.level=INFO` (ไม่เปิด `--api`)
  - `worker`: build `apps/worker/Dockerfile` (context = root), `container_name: vpsm-worker`, `mem_limit: 768m`, `stop_grace_period: 60s`, volumes `/var/run/docker.sock:/var/run/docker.sock`, `vpsm-traefik-dynamic:/traefik/dynamic`, `vpsm-work:/var/lib/vpsm/work`, `env_file: .env`, depends_on postgres (healthy), network `control`, **ไม่มี `ports`**
- `.env.example`: `POSTGRES_PASSWORD=`, `DATABASE_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/postgres`, `APPS_DOMAIN=apps.example.com`, `ACME_EMAIL=`, `MEMORY_BUDGET_MB=5632`, `MAX_SERVICE_MEMORY_MB=2048`, `GITHUB_TOKEN=` (fine-grained token อ่านอย่างเดียว ใช้จนกว่าจะมี GitHub App ในแผน 3)
- `deploy/install-ubuntu.sh`: ติดตั้ง Docker Engine ด้วย `https://get.docker.com`, `ufw allow OpenSSH`, `ufw allow 80/tcp`, `ufw allow 443/tcp`, `ufw --force enable` (ช่วง 30000–32767 เปิดในแผน 4)
- `docs/operations.md` (ภาษาไทย): ตั้ง DNS `*.apps.example.com` → IP ของ VPS, ติดตั้ง, `cp .env.example .env`, `docker compose up -d --build`, คำสั่ง CLI (`docker compose exec worker node dist/cli.js …`), วิธีอัปเดต (`git pull && docker compose up -d --build`)

- [ ] **Step 1: เขียนไฟล์ทั้งหมดข้างบน**

- [ ] **Step 2: Build image ในเครื่อง**

Run: `docker compose build worker && docker compose run --rm --entrypoint sh worker -c "docker buildx version && railpack --version && git --version"`
Expected: แสดงเวอร์ชันของ buildx, `0.43.0` และ git โดยไม่มี error

- [ ] **Step 3: ติดตั้งบน VPS** (ทำโดยเจ้าของ VPS)

Run (บน VPS): `sudo bash deploy/install-ubuntu.sh && cp .env.example .env && <แก้ .env> && docker compose up -d --build`
Expected: `docker compose ps` แสดง postgres (healthy), traefik, worker เป็น running และ `docker compose logs worker` ไม่มี error

- [ ] **Step 4: ทดสอบ deploy แอปตัวอย่าง**

Run (บน VPS):
```bash
docker compose exec worker node dist/cli.js project:create demo
docker compose exec worker node dist/cli.js service:create demo hello --repo xkiixr/vps-management --branch master --root examples/hello-node --healthcheck /health
docker compose exec worker node dist/cli.js status demo
curl -s https://hello-demo.$APPS_DOMAIN/
docker inspect buildx_buildkit_vpsm-builder0 --format '{{.HostConfig.Memory}}'
```
Expected: ภายใน ~5 นาที `status` แสดง `hello  SUCCESS  https://hello-demo.<APPS_DOMAIN>`, `curl` ได้ `hello from vpsm` ผ่าน HTTPS ที่ใบรับรองถูกต้อง และ memory ของ builder = `3221225472`

- [ ] **Step 5: ทดสอบ deploy แบบไม่ล่ม**

Run: terminal ที่ 1 `while true; do curl -s -o /dev/null -w '%{http_code}\n' https://hello-demo.$APPS_DOMAIN/; sleep 0.2; done` / terminal ที่ 2 `docker compose exec worker node dist/cli.js deploy demo hello`
Expected: terminal ที่ 1 ได้แต่ `200` ตลอดการ deploy และ `status` แสดง SUCCESS ของ deployment ใหม่

- [ ] **Step 6: ทดสอบกู้งานค้าง**

Run: สั่ง `deploy demo hello` แล้ว `docker compose restart worker` ระหว่าง build
Expected: deployment นั้นเป็น `FAILED` (`worker restarted during deployment`) เว็บยังตอบ `200` และ `docker ps --filter label=vpsm.managed=true` เหลือ container เดียวของ hello

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: docker compose deployment, VPS install script and operations guide"
```
