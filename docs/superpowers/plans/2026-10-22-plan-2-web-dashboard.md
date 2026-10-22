# Plan 2 — Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้ทีมจัดการทุกอย่างผ่านหน้าเว็บที่ `https://panel.<APPS_DOMAIN>` แทนการ SSH: ล็อกอิน, จัดการ user, project/service/สมาชิก, ปุ่ม deploy/rollback/restart, ประวัติ deploy + log, ตั้งค่าระบบ

**Architecture:** แอป Next.js ใหม่ `apps/web` (App Router, server components อ่านข้อมูล, server actions แก้ข้อมูล) ใช้ `@vpsm/db` ตัวเดียวกับ worker และ**ไม่มีสิทธิ์เข้า Docker socket** งานที่ต้องแตะ Docker ทำผ่านตาราง/คิวที่ worker อ่าน (deploy/rollback/restart = แถวใน `deployments`; ลบ service = ลบแถวแล้ว worker เก็บกวาด container ที่ค้าง) Traefik ส่ง `panel.<APPS_DOMAIN>` ไปที่ container `vpsm-web` ผ่าน route ที่ worker เขียน

**Tech Stack:** Next.js 16 (App Router) + React 19, TypeScript, Tailwind CSS 4, shadcn/ui (คัดลอก component เข้า repo), `zod`, `@node-rs/argon2`, Vitest, Playwright (smoke test), ของเดิมจาก Plan 1 (`@vpsm/core`, `@vpsm/db`, `@vpsm/worker`)

**Spec:** [docs/superpowers/specs/2026-10-21-railway-like-paas-design.md](../specs/2026-10-21-railway-like-paas-design.md) (ข้อ 2 ผู้ใช้และสิทธิ์, 3.1, 4, 5.2, 5.8, 6)

## Global Constraints

- ทุกอย่างจาก Plan 1 Global Constraints ยังใช้ (TypeScript ทั้งระบบ, Node 24, ฟรี/open-source, docker compose ไฟล์เดียว + override, ห้ามแบรนด์ Railway, ห้ามพิมพ์ secret)
- ผู้ใช้คือทีมภายใน **ไม่มีหน้าสมัครสมาชิก** admin สร้างบัญชีให้ (spec ข้อ 2)
- 2 บทบาท: `admin` (จัดการ user, ตั้งค่าระบบ, เห็นทุก project) และ `member` (สร้าง project และเห็นเฉพาะ project ที่เป็นสมาชิก) สมาชิกทุกคนใน project มีสิทธิ์เท่ากัน รวมถึงเชิญ/ลบสมาชิก
- `web` **ห้ามเข้า Docker socket** และห้ามเปิด port ของตัวเอง เข้าได้ทาง Traefik เท่านั้น
- panel อยู่ที่ `panel.<APPS_DOMAIN>` ซึ่งเป็น same-site กับแอปของทีม (spec ข้อ 4, ตัดสินแล้ว 2026-10-22) ดังนั้น:
  - session cookie ชื่อ `__Host-vpsm_session` เป็น `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/` และไม่มี `Domain`
  - **ทุก mutation** (server action) ต้องผ่าน `assertSameOrigin()` ที่เทียบ header `Origin` กับ `PANEL_ORIGIN` แบบเป๊ะ ไม่ตรงหรือไม่มี → ปฏิเสธ
  - ชื่อ `panel.<APPS_DOMAIN>` ห้ามเป็นโดเมนของแอป
- รหัสผ่าน: argon2id (`@node-rs/argon2` ค่าเริ่มต้น) ยาวอย่างน้อย 12 ตัว เก็บแต่ hash; session token สุ่ม 32 bytes, DB เก็บแต่ SHA-256 ของ token, อายุ 7 วัน ต่ออายุอัตโนมัติเมื่อเหลือน้อยกว่า 6 วัน
- ล็อกอินผิดจาก IP+อีเมลเดียวกันเกิน 10 ครั้งใน 15 นาที → ปฏิเสธชั่วคราว ข้อความ error ของการล็อกอินไม่บอกว่าอีเมลมีอยู่หรือไม่
- การแก้ค่าตั้ง service: **บันทึกแล้ว redeploy ทันทีเป็นค่าเริ่มต้น** มีตัวเลือก "บันทึกโดยยังไม่ deploy" และแถบเตือน "ค่าตั้งเปลี่ยนตั้งแต่ deploy ล่าสุด" (spec 5.2)
- restart จากเว็บ = deploy image เดิมของ deployment ที่ live อยู่ใหม่แบบไม่ล่ม (trigger `restart`) ไม่ใช่ `docker restart`
- งบ RAM รวมและ limit สูงสุดต่อ service ย้ายไปเก็บในตาราง `settings` (admin แก้จากเว็บ) ค่าใน env กลายเป็นค่าเริ่มต้นเมื่อยังไม่มีในตาราง
- บันทึก audit event ทุก action ที่แก้ข้อมูล (หน้าดู audit เลื่อนไป v2 ตาม spec)
- UI ภาษาอังกฤษสั้นๆ ก่อนได้ (ทีมเป็นนักพัฒนา) ข้อความ error ที่มาจาก `ValidationError` แสดงตรงตามที่ได้
- Canvas และ log สด (SSE) เป็นของ Plan 5 ใน Plan 2 หน้า log ใช้การ poll ทุก 3 วินาทีขณะ deployment ยังไม่จบ

## Review Focus

1. **แอปของทีม (same-site) ยิง form/fetch มาที่ panel** → ทุก server action ต้องปฏิเสธเมื่อ `Origin` ไม่ใช่ `PANEL_ORIGIN` → test ใน Task 6
2. **user ถูกปิดบัญชีขณะยังมี session ค้าง** → request ถัดไปต้องถูกเด้งไปหน้า login ทันที → test ใน Task 6
3. **member เปิด URL ของ project ที่ตัวเองไม่ได้เป็นสมาชิก** → ได้ 404 (ไม่บอกว่ามี project นั้นอยู่) และ action ใดๆ บน project นั้นถูกปฏิเสธ → test ใน Task 3 และ Task 7
4. **ลบ service ขณะกำลัง build/deploy** → ปฏิเสธพร้อมเหตุผล ส่วนการลบปกติ: container, network, image และ route ของ service นั้นหายภายในรอบเก็บกวาดถัดไป → test ใน Task 3 และ Task 5
5. **กรอกค่าตั้งผิด** (memory 0 หรือเกินค่าสูงสุด, port 70000, healthcheck ไม่ขึ้นต้น `/`, repo มีช่องว่าง, rootDirectory มี `..`) → แสดง error ที่ช่องนั้น ไม่บันทึก และไม่มี deployment เข้าคิว → test ใน Task 1 และ Task 8

---

## File Structure

```
packages/core/src/validation.ts            # ตรวจ input ของ service (repo, branch, port, healthcheck, rootDirectory, memory)
packages/db/migrations/0001_*.sql         # users, sessions, project_members, audit_events, settings, FK created_by
packages/db/src/schema.ts                  # + ตารางใหม่
packages/db/src/users.ts                   # user + password + session
packages/db/src/access.ts                  # สมาชิก project + สิทธิ์
packages/db/src/services.ts                # รายการ/แก้ค่าตั้ง/ลบ service, ภาพรวม project
packages/db/src/history.ts                 # ประวัติ deployment + log
packages/db/src/audit.ts, settings.ts
apps/worker/src/maintenance/sweep.ts       # เก็บกวาด container/network/image ที่ไม่มีแถวใน DB แล้ว
apps/web/                                  # Next.js app
  next.config.ts, Dockerfile, playwright.config.ts
  src/server/{config,db,session,auth,origin,rate-limit,guards}.ts
  src/server/actions/{auth,projects,services,deployments,admin,account}.ts
  src/app/(auth)/login/page.tsx
  src/app/(app)/layout.tsx, page.tsx                           # รายการ project
  src/app/(app)/projects/[project]/page.tsx                     # service ใน project
  src/app/(app)/projects/[project]/members/page.tsx
  src/app/(app)/projects/[project]/services/[service]/page.tsx  # ประวัติ deploy + ค่าตั้ง + ลบ
  src/app/(app)/projects/[project]/deployments/[id]/page.tsx    # log
  src/app/(app)/admin/users/page.tsx, admin/settings/page.tsx, account/page.tsx
  src/components/ui/*                                           # shadcn
  test/*.test.ts, e2e/smoke.spec.ts
```

---

### Task 1: Validation ใน core, schema ใหม่, trigger `restart`

**Files:**
- Create: `packages/core/src/validation.ts`, `packages/core/test/validation.test.ts`
- Modify: `packages/core/src/types.ts` (เพิ่ม `'restart'` ใน `DeploymentTrigger`), `packages/core/src/index.ts`
- Modify: `packages/db/src/schema.ts`; Create: `packages/db/migrations/0001_*.sql` (drizzle-kit generate `--name auth_and_access`)
- Test: `packages/db/test/schema.test.ts` (เพิ่ม)

**Interfaces:**
- Produces (core):
  - `type FieldErrors = Partial<Record<'repo' | 'branch' | 'rootDirectory' | 'healthcheckPath' | 'port' | 'memoryLimitMB' | 'startCommand', string>>`
  - `validateServiceInput(i: { repo?: string; branch?: string; rootDirectory?: string; healthcheckPath?: string; port?: number; memoryLimitMB?: number; startCommand?: string }, limits: { maxServiceMemoryMb: number }): FieldErrors` — คืน `{}` เมื่อผ่าน กฎ: repo `^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$`; branch ไม่ว่าง ไม่มีช่องว่าง ไม่ขึ้นต้น `-`; rootDirectory ห้ามมี segment `..`; healthcheckPath ขึ้นต้น `/` ไม่มีช่องว่าง; port จำนวนเต็ม 1–65535; memory จำนวนเต็ม 6..maxServiceMemoryMb; startCommand ≤ 1000 ตัวอักษร ข้อความ error ตามตาราง test
  - `DeploymentTrigger` = `'push' | 'manual' | 'rollback' | 'config' | 'restart'`
- Produces (db schema, Drizzle):
  - `users(id uuid pk default gen_random_uuid(), email text not null unique /* เก็บตัวเล็กเสมอ */, name text not null, password_hash text not null, role text check in ('admin','member') not null, disabled_at timestamptz null, created_at)`
  - `sessions(id text pk /* sha256 hex ของ token */, user_id → users cascade, created_at, expires_at timestamptz not null)` + index `(user_id)`
  - `project_members(project_id → projects cascade, user_id → users cascade, created_at, primary key(project_id, user_id))`
  - `audit_events(id bigserial pk, actor_id uuid → users set null, action text not null, target_type text not null, target_id text, metadata jsonb, created_at)` + index `(created_at desc)`
  - `settings(key text pk, value jsonb not null, updated_at, updated_by uuid → users set null)`
  - `deployments.created_by_id` → FK `users(id)` on delete set null
  - type `User`, `Session`, `ProjectMember`, `AuditEvent`

- [ ] **Step 1: เขียน test ที่ fail**

```ts
// packages/core/test/validation.test.ts
const limits = { maxServiceMemoryMb: 2048 }
test('valid input has no errors', () => {
  expect(validateServiceInput({ repo: 'acme/web', branch: 'main', rootDirectory: 'apps/web', healthcheckPath: '/health', port: 3000, memoryLimitMB: 512 }, limits)).toEqual({})
})
test.each([
  [{ repo: 'acme web' }, 'repo', 'use the form owner/name'],
  [{ branch: '' }, 'branch', 'branch is required'],
  [{ branch: '-x' }, 'branch', 'invalid branch name'],
  [{ rootDirectory: 'a/../../etc' }, 'rootDirectory', 'must stay inside the repository'],
  [{ healthcheckPath: 'health' }, 'healthcheckPath', 'must start with /'],
  [{ port: 70000 }, 'port', 'must be between 1 and 65535'],
  [{ memoryLimitMB: 0 }, 'memoryLimitMB', 'must be between 6 and 2048 MB'],
  [{ memoryLimitMB: 4096 }, 'memoryLimitMB', 'must be between 6 and 2048 MB'],
])('%j → %s error', (input, field, message) => {
  expect(validateServiceInput(input, limits)[field as keyof FieldErrors]).toBe(message)
})
// packages/db/test/schema.test.ts (เพิ่ม)
test('user emails are unique', async () => { /* insert same email twice → rejects with cause.code 23505 */ })
test('deleting a user nulls deployments.created_by_id and audit actor', async () => { /* … */ })
test('deleting a project cascades members', async () => { /* … */ })
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project core --project db` → FAIL
- [ ] **Step 3: เขียนโค้ดตาม Interfaces แล้ว generate migration** — `corepack pnpm --filter @vpsm/db exec drizzle-kit generate --name auth_and_access`
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run && corepack pnpm -r exec tsc --noEmit` → PASS (test เดิมที่ hard-code จำนวนตารางใน `migrate.test.ts` ให้แก้เป็นนับจาก `meta/_journal.json`)
- [ ] **Step 5: Commit** — `feat(db): users, sessions, members, audit and settings tables; service input validation`

---

### Task 2: User, password และ session (`@vpsm/db`)

**Files:**
- Create: `packages/db/src/users.ts`, `packages/db/test/users.test.ts`; Modify: `packages/db/src/index.ts`, `packages/db/package.json` (+ `@node-rs/argon2`)

**Interfaces:**
- Produces:
  - `MIN_PASSWORD_LENGTH = 12`, `SESSION_TTL_MS = 7 * 24 * 3600_000`, `SESSION_RENEW_BELOW_MS = 6 * 24 * 3600_000`
  - `hashPassword(plain: string): Promise<string>`, `verifyPassword(hash: string, plain: string): Promise<boolean>`
  - `generatePassword(): string` — 20 ตัว จาก `[A-Za-z0-9]` ด้วย `crypto.randomInt`
  - `createUser(db, i: { email: string; name: string; role: 'admin' | 'member'; password: string }): Promise<User>` — อีเมล trim + ตัวเล็ก + ต้องมี `@`; รหัสสั้นกว่า 12 → `ValidationError('password must be at least 12 characters')`; ซ้ำ → `ValidationError('a user with this email already exists')`
  - `setPassword(db, userId: string, password: string): Promise<void>` — ลบทุก session ของ user นั้นด้วย
  - `setUserRole(db, userId, role)`, `setUserDisabled(db, userId, disabled: boolean): Promise<void>` — disable ลบทุก session; ห้ามทำให้ admin ที่ active เหลือ 0 คน → `ValidationError('at least one active admin is required')`
  - `authenticate(db, email: string, password: string): Promise<User | null>` — null ถ้าไม่มี user, ถูกปิด หรือรหัสผิด (ถ้าไม่มี user ให้ verify กับ hash หลอกเพื่อเวลาใกล้เคียงกัน)
  - `createSession(db, userId: string): Promise<{ token: string; expiresAt: Date }>` — token = 32 bytes base64url
  - `resolveSession(db, token: string): Promise<{ user: User; sessionId: string; expiresAt: Date; renewed: boolean } | null>` — null ถ้าไม่มี/หมดอายุ/user ถูกปิด; ถ้าเหลืออายุ < `SESSION_RENEW_BELOW_MS` ให้ต่อเป็น `now + SESSION_TTL_MS` และ `renewed: true`
  - `deleteSession(db, token: string): Promise<void>`, `purgeExpiredSessions(db): Promise<number>`
  - `listUsers(db): Promise<User[]>` (เรียงตามอีเมล)

- [ ] **Step 1: เขียน test ที่ fail**

```ts
test('createUser lowercases email and refuses short passwords', async () => { /* 'A@X.io' → 'a@x.io'; 'short' → ValidationError */ })
test('authenticate accepts the right password only', async () => { /* right → user; wrong → null; unknown email → null */ })
test('disabled users cannot authenticate and lose their sessions', async () => {
  const { token } = await createSession(db, u.id); await setUserDisabled(db, u.id, true)
  expect(await resolveSession(db, token)).toBeNull(); expect(await authenticate(db, u.email, pw)).toBeNull()
})
test('sessions store only a hash of the token', async () => { /* select id from sessions !== token, === sha256 hex */ })
test('expired sessions resolve to null and are purged', async () => { /* set expires_at past → null; purgeExpiredSessions → 1 */ })
test('sessions renew when less than 6 days remain', async () => { /* set expires_at = now+1d → renewed true, expiresAt ≈ now+7d */ })
test('cannot disable or demote the last active admin', async () => { /* → ValidationError */ })
test('setPassword invalidates existing sessions', async () => { /* … */ })
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project db` → FAIL
- [ ] **Step 3: เขียน `users.ts` ตาม Interfaces**
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run --project db && corepack pnpm -r exec tsc --noEmit`
- [ ] **Step 5: Commit** — `feat(db): users, password hashing and sessions`

---

### Task 3: สิทธิ์, สมาชิก, ค่าตั้ง service, ลบ, ประวัติ, audit, settings (`@vpsm/db`)

**Files:**
- Create: `packages/db/src/{access,services,history,audit,settings}.ts` + test แต่ละไฟล์; Modify: `packages/db/src/projects.ts` (`createProject` รับ `creatorId?`), `index.ts`

**Interfaces:**
- Consumes: Task 1 (`validateServiceInput`, tables), Task 2 (`User`)
- Produces:
  - `type Actor = { id: string; role: 'admin' | 'member' }`
  - `createProject(db, name: string, creatorId?: string): Promise<Project>` — ถ้ามี `creatorId` เพิ่มเป็นสมาชิกใน transaction เดียวกัน (CLI เดิมเรียกแบบไม่มี creatorId ได้เหมือนเดิม)
  - `listProjectsFor(db, actor: Actor): Promise<{ project: Project; serviceCount: number }[]>` — admin เห็นทั้งหมด, member เห็นเฉพาะที่เป็นสมาชิก, เรียงตามชื่อ
  - `findProjectFor(db, actor: Actor, projectName: string): Promise<Project | null>` — null เมื่อไม่มี **หรือไม่มีสิทธิ์** (ห้ามแยกสองกรณี)
  - `listMembers(db, projectId): Promise<{ user: Pick<User,'id'|'email'|'name'>; addedAt: Date }[]>`
  - `addMember(db, projectId, email: string): Promise<void>` — ไม่มี user → `ValidationError('no user with that email')`; มีอยู่แล้ว → ไม่ error
  - `removeMember(db, projectId, userId): Promise<void>` — ห้ามลบจนไม่เหลือสมาชิก → `ValidationError('a project needs at least one member')`
  - `type ServiceRow = { service: Service; instance: ServiceInstance; url: string | null; latest: Pick<Deployment,'id'|'status'|'createdAt'> | null; live: Pick<Deployment,'id'|'imageTag'|'configSnapshot'> | null }`
  - `listServices(db, projectId, opts: { appsDomain: string; httpsPort: number }): Promise<ServiceRow[]>` — `url` = `publicUrl(โดเมน generated ตัวแรก, httpsPort)`
  - `findService(db, projectId, serviceName, opts): Promise<ServiceRow | null>`
  - `configChangedSinceLiveDeploy(row: ServiceRow): boolean` — เทียบ `instance.source/build/deploy` กับ `live.configSnapshot` (ไม่มี live → false)
  - `updateServiceConfig(db, instanceId, patch: { repo?, branch?, rootDirectory?, healthcheckPath?, port?, memoryLimitMB?, startCommand? }, limits): Promise<{ ok: true } | { ok: false; errors: FieldErrors }>` — ใช้ `validateServiceInput`; ค่าว่าง `''` ของ optional field = ลบค่านั้น
  - `deleteService(db, instanceId): Promise<void>` — ถ้ามี deployment `BUILDING`/`DEPLOYING` หรือ `QUEUED` ที่ถูก claim แล้ว → `ValidationError('wait for the running deployment to finish')`; ไม่งั้นลบ service (cascade) แล้ว `pg_notify('vpsm_cleanup', '')` ใน transaction เดียวกัน
  - `deleteProject(db, projectId): Promise<void>` — กติกาเดียวกันกับทุก service ใน project แล้ว notify
  - `CLEANUP_CHANNEL = 'vpsm_cleanup'`
  - `listDeployments(db, instanceId, limit = 50): Promise<(Deployment & { createdByEmail: string | null })[]>` (ใหม่สุดก่อน)
  - `findDeploymentInProject(db, projectId, deploymentId): Promise<Deployment | null>` — ตรวจ uuid ก่อน query
  - `readLogs(db, deploymentId, afterId = 0, limit = 2000): Promise<{ id: number; phase: 'build'|'deploy'; line: string }[]>`
  - `recordAudit(db, e: { actorId: string | null; action: string; targetType: string; targetId?: string; metadata?: Record<string, unknown> }): Promise<void>` — `metadata` ห้ามมีรหัสผ่าน/token (caller รับผิดชอบ, ใส่ comment)
  - `RESOURCE_KEYS = { memoryBudgetMb: 'memoryBudgetMb', maxServiceMemoryMb: 'maxServiceMemoryMb' }`
  - `getResourceSettings(db): Promise<{ memoryBudgetMb?: number; maxServiceMemoryMb?: number }>`
  - `setResourceSettings(db, v: { memoryBudgetMb: number; maxServiceMemoryMb: number }, actorId: string): Promise<void>` — ทั้งคู่จำนวนเต็มบวก, `maxServiceMemoryMb ≤ memoryBudgetMb`, max ≥ 6 → ไม่งั้น `ValidationError`

- [ ] **Step 1: เขียน test ที่ fail** (ไฟล์ละกลุ่ม ตัวอย่างสำคัญ)

```ts
test('members see only their projects; admins see all', async () => { /* 2 projects, member in one */ })
test('findProjectFor returns null for an existing project the member is not in', async () => {
  expect(await findProjectFor(db, outsider, 'shop')).toBeNull()
})
test('cannot remove the last member', async () => { /* → ValidationError */ })
test('updateServiceConfig refuses invalid values and saves nothing', async () => {
  const r = await updateServiceConfig(db, instanceId, { port: 70000, healthcheckPath: 'x' }, { maxServiceMemoryMb: 2048 })
  expect(r).toEqual({ ok: false, errors: { port: 'must be between 1 and 65535', healthcheckPath: 'must start with /' } })
  expect((await reload(instanceId)).deploy.port).toBe(8080)
})
test('configChangedSinceLiveDeploy detects saved-but-not-deployed changes', async () => { /* … */ })
test('deleteService refuses while a deployment is building', async () => { /* status BUILDING → ValidationError */ })
test('deleteService removes rows and notifies cleanup', async () => { /* listen CLEANUP_CHANNEL; service gone; domains gone */ })
test('settings: max cannot exceed budget', async () => { /* → ValidationError */ })
test('readLogs pages by id', async () => { /* afterId */ })
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project db` → FAIL
- [ ] **Step 3: เขียนโค้ดตาม Interfaces** (ใช้ `publicUrl` จาก core)
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run && corepack pnpm -r exec tsc --noEmit`
- [ ] **Step 5: Commit** — `feat(db): project access, service config, deletion, history, audit and settings`

---

### Task 4: Worker — settings จาก DB, restart, route ของ panel, CLI จัดการ user

**Files:**
- Modify: `apps/worker/src/config.ts` (+ `panelDomain`, `panelUpstream`), `deploy/pipeline.ts` (`checkResources`, trigger `restart`), `routing/active-routes.ts` (route panel + กันชื่อชน), `cli.ts` (คำสั่ง user + audit), `main.ts`
- Test: `apps/worker/test/{config,pipeline,active-routes,cli}.test.ts` (เพิ่ม)

**Interfaces:**
- Consumes: Task 2 (`createUser`, `generatePassword`, `setPassword`, `listUsers`), Task 3 (`getResourceSettings`, `recordAudit`)
- Produces:
  - config: `panelDomain?: string` จาก `PANEL_DOMAIN` (ต้องผ่าน `isValidHostname`, ไม่บังคับ), `panelUpstream: string` จาก `PANEL_UPSTREAM` (ค่าเริ่มต้น `http://vpsm-web:3000`, ต้องตรง `^http://[a-z0-9-]+:[0-9]+$`)
  - `checkResources` ใช้ `{ ...config, ...await getResourceSettings(db) }` (ค่าใน DB ชนะ env)
  - trigger `restart`: ทำแบบเดียวกับ `rollback` ทุกอย่าง (`rollbackOfId` ชี้ deployment ที่ live)
  - `regenerateRoutes(db, dir, onInvalid?, tls?, panel?: { domain: string; upstream: string })` — ถ้ามี `panel` เพิ่ม route `{ serviceInstanceId: 'panel', hostnames: [domain], upstreamUrl: upstream }`; route ของแอปที่มี hostname เท่ากับ `domain` ถูกข้ามผ่าน `onInvalid(id, 'hostname is reserved for the panel')`
  - CLI: `user:create <email> --name <name> [--admin]` → พิมพ์ `created user <email> (admin|member)` และ `password: <generated>` ครั้งเดียว; `user:reset-password <email>` → พิมพ์รหัสใหม่; `user:list` → `<email>  <role>  <active|disabled>`; ทุกคำสั่งที่แก้ข้อมูล (รวมของเดิม) เรียก `recordAudit` ด้วย `actorId: null`, `metadata: { via: 'cli' }`
  - CLI `service:create --memory` ใช้ max จาก `getResourceSettings` ก่อน env

- [ ] **Step 1: เขียน test ที่ fail**

```ts
test('memory budget from settings overrides env', async () => { /* settings budget 1024, running 1024 → FAILED 'memory budget exceeded…' */ })
test('restart reuses the live image without building', async () => { /* trigger 'restart' → events no fetch/build; image = live.imageTag */ })
test('panel route is rendered and app routes cannot take the panel hostname', async () => { /* … */ })
test('user:create prints a generated password once and records audit', async () => { /* out has /^password: [A-Za-z0-9]{20}$/; audit row via cli */ })
test('PANEL_DOMAIN must be a valid hostname', () => { /* 'Bad Host' → throws naming PANEL_DOMAIN */ })
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project worker` → FAIL
- [ ] **Step 3: เขียนโค้ดตาม Interfaces**
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run && corepack pnpm -r exec tsc --noEmit`
- [ ] **Step 5: Commit** — `feat(worker): db settings, restart trigger, panel route and user CLI`

---

### Task 5: Worker — เก็บกวาดของที่ไม่มีเจ้าของ (sweep)

**Files:**
- Create: `apps/worker/src/maintenance/sweep.ts`, `apps/worker/test/sweep.test.ts`
- Modify: `apps/worker/src/runtime/docker-runtime.ts` (+ 3 method), `test/fakes.ts`, `deploy/loop.ts` (บอกว่า busy อยู่หรือไม่), `main.ts`

**Interfaces:**
- Consumes: Task 3 (`CLEANUP_CHANNEL`), Plan 1 recovery (orphan rule)
- Produces:
  - `DockerRuntime.listManagedNetworks(): Promise<string[]>` (ชื่อขึ้นต้น `vpsm-env-`), `removeNetwork(name: string): Promise<void>` (disconnect ทุก container ที่ต่ออยู่ก่อน, เงียบเมื่อไม่มี), `listManagedImages(): Promise<string[]>` (tag ที่ขึ้นต้น `vpsm/`)
  - `sweepOrphans(deps: PipelineDeps): Promise<{ containers: number; networks: number; images: number }>`:
    1. container ที่ managed แต่ deployment ไม่ใช่ `SUCCESS`/`CRASHED` (รวมแถวที่ถูกลบ) → `stopAndRemove(name, 10)`
    2. network `vpsm-env-<id>` ที่ไม่มีแถวใน `environments` → `removeNetwork`
    3. image `vpsm/<instanceId>:*` ที่ไม่มีแถวใน `service_instances` → `removeImage`
    4. `regenerateRoutes()`
    ทีละรายการมี try/catch + log (ตามแบบ recovery)
  - deploy loop export `isBusy(): boolean`; `main.ts` เรียก `sweepOrphans` เมื่อได้ notify `CLEANUP_CHANNEL` และทุก 60 วินาที **เฉพาะตอน loop ไม่ busy** (กันลบ container ของ deploy ที่กำลังรัน) และกันรันซ้อนด้วย flag

- [ ] **Step 1: เขียน test ที่ fail**

```ts
test('removes containers, networks and images of a deleted service and rewrites routes', async () => { /* create svc → live deployment → deleteService → sweep → counts 1/1/n, events 'routes' */ })
test('never touches the live container of an existing service', async () => { /* … */ })
test('one failing removal does not stop the rest', async () => { /* … */ })
test('skips while a deployment is running', async () => { /* main wiring helper: busy → sweep not called */ })
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project worker` → FAIL
- [ ] **Step 3: เขียนโค้ดตาม Interfaces** (+ integration test ใน `docker-runtime.int.test.ts` สำหรับ 3 method ใหม่ รันด้วย `DOCKER_HOST=… INTEGRATION=1`)
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run && corepack pnpm -r exec tsc --noEmit`
- [ ] **Step 5: Commit** — `feat(worker): sweep orphaned containers, networks and images`

---

### Task 6: Web — โครงแอป, ล็อกอิน, session, Origin check

**Files:**
- Create: `apps/web/` (package `@vpsm/web`, `next.config.ts` ด้วย `output: 'standalone'`, `outputFileTracingRoot` = รากของ repo (monorepo), `transpilePackages: ['@vpsm/core','@vpsm/db']`, `serverExternalPackages: ['@node-rs/argon2','postgres']`), Tailwind 4, shadcn/ui (`button`, `input`, `label`, `card`, `table`, `badge`, `dialog`, `select`, `alert`, `tabs`)
- Create: `src/server/{config,db,session,auth,origin,rate-limit,guards}.ts`, `src/server/actions/auth.ts`, `src/app/(auth)/login/page.tsx`, `src/app/(app)/layout.tsx` (แถบบน: ชื่อ, ลิงก์ Projects / Admin (admin เท่านั้น) / Account, ปุ่ม Logout), `src/app/(app)/page.tsx` (placeholder จนถึง Task 7)
- Test: `apps/web/test/{origin,rate-limit,session,guards}.test.ts`

**Interfaces:**
- Consumes: Task 2 (`authenticate`, `createSession`, `resolveSession`, `deleteSession`)
- Produces:
  - `webConfig()`: `{ databaseUrl, appsDomain, panelDomain, httpsPort, panelOrigin }` จาก env `DATABASE_URL`, `APPS_DOMAIN`, `PANEL_DOMAIN`, `PUBLIC_HTTPS_PORT` (ค่าเริ่มต้น 443), `panelOrigin = publicUrl(panelDomain, httpsPort)`; ยอมให้ตั้ง `PANEL_ORIGIN` ทับได้เพื่อ dev/test (เช่น `http://localhost:3100`) ค่าที่ไม่ถูกต้อง → throw ที่บอกชื่อตัวแปร
  - `getDb()` — singleton ต่อ process
  - `SESSION_COOKIE = '__Host-vpsm_session'`
  - `assertSameOrigin(h: Headers, panelOrigin: string): void` — throw `ForbiddenError('cross-origin request refused')` ถ้า `Origin` ไม่มีหรือไม่ตรงเป๊ะ
  - `createLoginLimiter({ max: 10, windowMs: 15 * 60_000 })`: `{ check(key: string): boolean; fail(key: string): void; reset(key: string): void }` (in-memory, key = `${ip}|${email}`)
  - `currentUser(): Promise<User | null>` — อ่าน cookie → `resolveSession`; ถ้า renewed ให้ตั้ง cookie ใหม่
  - `requireUser(): Promise<User>` (ไม่มี → `redirect('/login')`), `requireAdmin(): Promise<User>` (member → `notFound()`)
  - actions: `loginAction(prev, formData)` → ผิด: `{ error: 'invalid email or password' }` หรือ `{ error: 'too many attempts, try again later' }`; ถูก: ตั้ง cookie แล้ว `redirect('/')`; `logoutAction()` — ทั้งคู่เรียก `assertSameOrigin` ก่อน
  - **กฎ:** ทุก server action ในทุก task ต่อจากนี้ต้องเริ่มด้วย `assertSameOrigin(await headers(), webConfig().panelOrigin)` แล้วตามด้วย `requireUser()`/`requireAdmin()`
- [ ] **Step 1: เขียน test ที่ fail**

```ts
test('assertSameOrigin accepts only the exact panel origin', () => {
  const ok = new Headers({ origin: 'https://panel.x.duckdns.org:8443' })
  expect(() => assertSameOrigin(ok, 'https://panel.x.duckdns.org:8443')).not.toThrow()
  for (const o of ['https://hello-demo.x.duckdns.org:8443', 'https://panel.x.duckdns.org', 'null', ''])
    expect(() => assertSameOrigin(new Headers(o ? { origin: o } : {}), 'https://panel.x.duckdns.org:8443')).toThrow('cross-origin request refused')
})
test('limiter blocks the 11th failure inside the window and resets on success', () => { /* fake clock */ })
test('webConfig builds the origin with the port', () => { /* PANEL_DOMAIN + PUBLIC_HTTPS_PORT=8443 → https://…:8443 */ })
test('currentUser rejects a disabled user with a live session', async () => { /* mock cookies() via helper param; setUserDisabled → null */ })
```
  (แยก logic ที่ test ได้ออกจาก `next/headers`: ฟังก์ชันรับ `cookies`/`headers` เป็นพารามิเตอร์ ตัว wrapper บางๆ เรียก `next/headers`)

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project web` → FAIL
- [ ] **Step 3: สร้างแอป + เขียนโค้ดตาม Interfaces** (หน้า login: ฟอร์ม email/password, ใช้ `useActionState`)
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run && corepack pnpm -r exec tsc --noEmit && corepack pnpm --filter @vpsm/web build`
- [ ] **Step 5: Commit** — `feat(web): next.js app with login, sessions and origin checks`

---

### Task 7: Web — project และสมาชิก

**Files:**
- Create: `src/server/actions/projects.ts`, `src/app/(app)/page.tsx` (แทน placeholder), `src/app/(app)/projects/[project]/page.tsx` (ส่วนหัว + ตาราง service แบบว่างก่อน Task 8), `src/app/(app)/projects/[project]/members/page.tsx`
- Test: `apps/web/test/projects-actions.test.ts`

**Interfaces:**
- Consumes: Task 3 (`listProjectsFor`, `findProjectFor`, `createProject`, `deleteProject`, `listMembers`, `addMember`, `removeMember`, `recordAudit`), Task 6 (guards)
- Produces (actions รับ `formData`, คืน `{ error?: string; fieldErrors?: FieldErrors }` หรือ redirect):
  - `createProjectAction` → สำเร็จ: audit `project.create` แล้ว `redirect('/projects/<name>')`
  - `deleteProjectAction(projectName)` → ต้องพิมพ์ชื่อ project ยืนยันในช่อง `confirm` ไม่ตรง → `{ error: 'type the project name to confirm' }`; audit `project.delete`
  - `addMemberAction(projectName)`, `removeMemberAction(projectName, userId)` → audit `member.add`/`member.remove`
  - ทุก action: `findProjectFor` คืน null → `notFound()`
  - logic ของ action แยกเป็นฟังก์ชัน `doCreateProject(db, actor, formData)` ฯลฯ เพื่อ test ได้โดยไม่ต้องรัน Next
- [ ] **Step 1: เขียน test ที่ fail** — `doCreateProject` สร้างพร้อมเป็นสมาชิก + audit; ชื่อผิด → `fieldErrors.name`; outsider เรียก `doAddMember` บน project คนอื่น → throw NotFound; ลบ project ต้องยืนยันชื่อ
- [ ] **Step 2: Run ให้ fail** → **Step 3: เขียนโค้ด + หน้า** (หน้าแรก: ตาราง project + ฟอร์มสร้าง; หน้า members: รายชื่อ + ฟอร์มเพิ่มด้วยอีเมล + ปุ่มลบ) → **Step 4: Run ให้ผ่าน** (`vitest run`, `tsc`, `web build`)
- [ ] **Step 5: Commit** — `feat(web): projects and members`

---

### Task 8: Web — service (สร้าง, ค่าตั้ง, ลบ)

**Files:**
- Create: `src/server/actions/services.ts`, `src/app/(app)/projects/[project]/page.tsx` (ตาราง service: ชื่อ, สถานะล่าสุดเป็น badge, URL, เวลา deploy ล่าสุด + ฟอร์ม New service), `src/app/(app)/projects/[project]/services/[service]/page.tsx` (แท็บ Deployments / Settings / Danger zone)
- Test: `apps/web/test/services-actions.test.ts`

**Interfaces:**
- Consumes: Task 3 (`listServices`, `findService`, `updateServiceConfig`, `deleteService`, `configChangedSinceLiveDeploy`, `getResourceSettings`), Plan 1 `createAppService`, `enqueueDeployment`
- Produces:
  - `createServiceAction(projectName)` — ฟิลด์: name, repo, branch (ค่าเริ่มต้น `main`), rootDirectory, healthcheckPath, port (8080), memoryLimitMB (512); validate ด้วย `validateServiceInput` + `validateName`; สำเร็จ → `createAppService` แล้ว `enqueueDeployment({ trigger: 'manual', createdById })`, audit `service.create`, redirect ไปหน้า service; error → `fieldErrors` และไม่สร้างอะไร
  - `saveServiceSettingsAction(projectName, serviceName)` — ปุ่ม 2 ปุ่มในฟอร์มเดียว `intent=save-deploy` (ค่าเริ่มต้น) | `intent=save-only`; `save-deploy` → `updateServiceConfig` แล้ว enqueue `config`; audit `service.update` (metadata = ชื่อฟิลด์ที่เปลี่ยน ไม่ใส่ค่า)
  - `deleteServiceAction(projectName, serviceName)` — ยืนยันด้วยชื่อ service; audit `service.delete`
  - หน้า service แสดงแถบเตือน "Settings changed since the last deploy" เมื่อ `configChangedSinceLiveDeploy` เป็นจริง และข้อความใต้ปุ่ม save-only ว่า push ครั้งถัดไปจะพาค่าตั้งนี้ขึ้นไปด้วย
- [ ] **Step 1: เขียน test ที่ fail** — ค่าผิด → `fieldErrors` ครบตาม Review Focus 5 และไม่มีแถวใน deployments; `save-only` ไม่ enqueue; `save-deploy` enqueue trigger `config`; ลบระหว่าง BUILDING → `{ error: 'wait for the running deployment to finish' }`
- [ ] **Step 2: Run ให้ fail** → **Step 3: เขียนโค้ด + หน้า** → **Step 4: Run ให้ผ่าน** (`vitest run`, `tsc`, `web build`)
- [ ] **Step 5: Commit** — `feat(web): create, configure and delete services`

---

### Task 9: Web — deploy, rollback, restart และ log

**Files:**
- Create: `src/server/actions/deployments.ts`, `src/app/(app)/projects/[project]/deployments/[id]/page.tsx`, `src/app/api/deployments/[id]/logs/route.ts` (GET อย่างเดียว คืน JSON log ต่อจาก `after`), component `LogViewer` (client: poll ทุก 3 วินาทีขณะสถานะยังไม่จบ, หยุดเมื่อจบ)
- Modify: แท็บ Deployments ในหน้า service
- Test: `apps/web/test/deployments-actions.test.ts`, `apps/web/test/logs-route.test.ts`

**Interfaces:**
- Consumes: Task 3 (`listDeployments`, `findDeploymentInProject`, `readLogs`), Plan 1 `enqueueDeployment`
- Produces:
  - `deployAction(p, s)` → enqueue `manual`; `restartAction(p, s)` → ต้องมี deployment SUCCESS → enqueue `restart` + `rollbackOfId = live.id` ไม่มี → `{ error: 'nothing is running to restart' }`; `rollbackAction(p, s, deploymentId)` → deployment ต้องเป็นของ service นี้และมี `imageTag` ไม่งั้น `{ error: 'this deployment has no image to roll back to' }`; audit `deployment.deploy` / `.restart` / `.rollback`
  - ตาราง Deployments: สถานะ (badge สีตามสถานะ), trigger, commit sha 7 ตัว + ข้อความ, ใครสั่ง, เวลา, `failureReason` (ถ้ามี), ลิงก์ Logs, ปุ่ม Rollback ในแถวที่มี image และไม่ใช่ตัวที่ live
  - route GET `/api/deployments/[id]/logs?after=<n>` → `requireUser` + สิทธิ์ project ของ deployment นั้น (ไม่มีสิทธิ์ → 404) คืน `{ lines, lastId, finished }` (GET ไม่แก้ข้อมูล จึงไม่ต้องตรวจ Origin แต่ต้องมี `Cache-Control: no-store`)
- [ ] **Step 1: เขียน test ที่ fail** — restart ไม่มี live → error; rollback ข้าม service → error; route log ของ project คนอื่น → 404; `after` ทำงาน; `finished` true เมื่อสถานะ SUCCESS/FAILED/CRASHED/REMOVED/SKIPPED
- [ ] **Step 2: Run ให้ fail** → **Step 3: เขียนโค้ด + หน้า** → **Step 4: Run ให้ผ่าน** (`vitest run`, `tsc`, `web build`)
- [ ] **Step 5: Commit** — `feat(web): deploy, rollback, restart and build logs`

---

### Task 10: Web — admin (users, settings) และบัญชีตัวเอง

**Files:**
- Create: `src/server/actions/{admin,account}.ts`, `src/app/(app)/admin/users/page.tsx`, `src/app/(app)/admin/settings/page.tsx`, `src/app/(app)/account/page.tsx`
- Test: `apps/web/test/admin-actions.test.ts`

**Interfaces:**
- Consumes: Task 2, Task 3 (`getResourceSettings`, `setResourceSettings`, `recordAudit`)
- Produces:
  - `createUserAction` (admin) — ฟิลด์ email, name, role; รหัสผ่านสร้างด้วย `generatePassword()` แสดงในหน้า**ครั้งเดียว**หลังสร้าง (คืนจาก action ไม่เก็บที่ไหน); audit `user.create` (ไม่มีรหัสใน metadata)
  - `resetPasswordAction(userId)`, `setRoleAction(userId, role)`, `setDisabledAction(userId, disabled)` (admin) — admin ปิด/ลดสิทธิ์ตัวเองได้เฉพาะเมื่อยังมี admin อื่นที่ active
  - `saveResourceSettingsAction` (admin) — ฟอร์มแสดงค่าปัจจุบัน (จาก DB หรือ env ถ้ายังไม่ตั้ง) audit `settings.update`
  - `changeOwnPasswordAction` — ต้องใส่รหัสเดิมถูก, รหัสใหม่ ≥ 12; สำเร็จ → `setPassword` (ล้างทุก session) แล้วสร้าง session ใหม่ให้ตัวเอง
  - member เปิด `/admin/*` → 404
- [ ] **Step 1: เขียน test ที่ fail** — member เรียก action ของ admin → NotFound; ปิด admin คนสุดท้าย → error; รหัสเดิมผิด → error; settings ผิด → error และไม่บันทึก
- [ ] **Step 2: Run ให้ fail** → **Step 3: เขียนโค้ด + หน้า** → **Step 4: Run ให้ผ่าน** (`vitest run`, `tsc`, `web build`)
- [ ] **Step 5: Commit** — `feat(web): user administration, resource settings and account`

---

### Task 11: Packaging, compose, docs และ smoke test

**Files:**
- Create: `apps/web/Dockerfile` (build stage `node:24-bookworm-slim` + pnpm → `next build` standalone; runtime `node:24-bookworm-slim`, user ไม่ใช่ root, `CMD ["node","apps/web/server.js"]`, port 3000)
- Create: `apps/web/playwright.config.ts`, `apps/web/e2e/smoke.spec.ts`
- Modify: `docker-compose.yml` (service `web`), `docker-compose.dns-tls.yml` (`web.environment.PUBLIC_HTTPS_PORT`), `.env.example` (`PANEL_DOMAIN`), `docs/operations.md`

**รายละเอียดที่ล็อกไว้:**
- `docker-compose.yml` service `web`: build `apps/web/Dockerfile` context root, `container_name: vpsm-web`, `env_file: .env`, networks `control` + `edge`, `mem_limit: 512m`, `mem_reservation: 128m`, `oom_score_adj: -900`, logging แบบเดียวกับ service อื่น, `depends_on: postgres (healthy)`, `restart: unless-stopped`, **ไม่มี `ports` และไม่มี docker socket**
- worker ได้ `PANEL_DOMAIN` จาก `.env` อยู่แล้ว (env_file) และ `PANEL_UPSTREAM` ใช้ค่าเริ่มต้น
- `.env.example`: `PANEL_DOMAIN=panel.apps.example.com` พร้อมคอมเมนต์ว่าต้องอยู่ใต้ `APPS_DOMAIN` ถ้าใช้ wildcard (dns-tls) และตัวอย่างของ VPS นี้คือ `panel.itexcellence.duckdns.org`
- `docs/operations.md`: ส่วนใหม่ "Dashboard": ตั้ง `PANEL_DOMAIN`, `git pull && sudo docker compose up -d --build`, สร้าง admin คนแรก `sudo docker compose exec worker node dist/cli.js user:create you@example.com --name "Your Name" --admin` (รหัสแสดงครั้งเดียว), เข้า `https://panel.<APPS_DOMAIN>[:8443]`, เปลี่ยนรหัสที่หน้า Account; คำเตือนว่า panel เป็น same-site กับแอปของทีม
- smoke test (Playwright, Chromium): รัน `next start` ที่ `http://localhost:3100` กับ test DB (`setupTestDb` แยก + `PANEL_ORIGIN=http://localhost:3100`) สร้าง admin ผ่าน `createUser` ใน global setup แล้วทดสอบ: login → สร้าง project `smoke` → สร้าง service `web` (repo `acme/web`) → เห็นหน้า service และแถว deployment `QUEUED` → logout แล้วเปิด `/` ถูกเด้งไป `/login`; รันด้วย `E2E=1 corepack pnpm --filter @vpsm/web exec playwright test` (ติดตั้ง browser ด้วย `corepack pnpm --filter @vpsm/web exec playwright install chromium`)

- [ ] **Step 1: เขียนไฟล์ทั้งหมดข้างบน**
- [ ] **Step 2: smoke test** — คำสั่งด้านบน → PASS
- [ ] **Step 3: build image** — `docker compose build web` แล้ว `docker compose config` (ใช้ `.env` ปลอมใน scratchpad) ต้องเห็น `web` ไม่มี `ports`
- [ ] **Step 4: ทุก test + typecheck** — `corepack pnpm vitest run && corepack pnpm -r exec tsc --noEmit` → PASS
- [ ] **Step 5: Commit** — `feat: web container, compose wiring, docs and smoke test`
- [ ] **Step 6 (เจ้าของ VPS):** ตั้ง `PANEL_DOMAIN=panel.itexcellence.duckdns.org` ใน `.env`, `git pull && sudo docker compose up -d --build`, สร้าง admin ด้วย CLI แล้วเข้า `https://panel.itexcellence.duckdns.org:8443` ล็อกอินได้ และกด Deploy บน service `hello` ได้สำเร็จ
