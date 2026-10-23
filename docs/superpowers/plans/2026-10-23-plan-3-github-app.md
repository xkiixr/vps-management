# Plan 3 — GitHub App และ push-to-deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** push โค้ดขึ้น branch ที่ผูกกับ service แล้ว service นั้น build และ deploy commit นั้นเองภายในราว 5 นาที โดย worker clone ด้วย installation token ของ GitHub App ตัวเดียวของทีม แทน `GITHUB_TOKEN` (personal token)

**Architecture:**
- **`apps/web` รับ webhook** ที่ `POST /api/github/webhook` ตรวจลายเซ็น `X-Hub-Signature-256` แล้วเข้าคิว deployment (`trigger: 'push'`, `commitSha` = `after` ของ payload) ให้ทุก service ที่ผูก repo+branch นั้น ผ่าน `enqueueDeployment` เดิม ซึ่งเปลี่ยน deployment ที่ยัง `QUEUED` ของ service เดียวกันเป็น `SKIPPED` อยู่แล้ว
- **`apps/worker` เป็นส่วนเดียวที่ถือ private key ของ App** ทำ 2 อย่าง:
  - ตอน clone แต่ละครั้ง: ออก JWT แล้วขอ installation token ที่จำกัดเฉพาะ repo นั้นและอ่านอย่างเดียว
  - sync รายชื่อ repo ที่ App อ่านได้ลงตาราง `github_repositories` ตอนเริ่ม, ทุก 10 นาที, และเมื่อได้ NOTIFY (web ส่งเมื่อได้ event `installation*` หรือ admin กด Sync)
- **web ไม่เรียก GitHub API เลย** อ่านรายชื่อ repo และสถานะของ App จาก Postgres

**Tech Stack:** ของเดิมทั้งหมด (Next.js 16, Drizzle, Vitest, Playwright) + `node:crypto` (JWT RS256, HMAC-SHA256) + `fetch` ของ Node 24 ไม่เพิ่ม dependency (ไม่ใช้ Octokit)

**Spec:** [docs/superpowers/specs/2026-10-21-railway-like-paas-design.md](../specs/2026-10-21-railway-like-paas-design.md) (ข้อ 2 GitHub App ตัวเดียว, 3.1 ข้อ 3, 3.4, 5.1 web รับ webhook, 5.2 "push ครั้งถัดไปพาค่าตั้งขึ้นไปด้วย", 5.3 ข้อ 1–2, 5.8, 6 Admin: GitHub App)

## Global Constraints

- ทุกข้อของ Plan 1 และ Plan 2 ยังใช้ (ห้ามพิมพ์ secret, web ไม่มี Docker socket และไม่เปิด port, audit ทุก action ที่แก้ข้อมูล ฯลฯ)
- **private key ของ App อยู่ที่ worker เท่านั้น**
  - เป็นไฟล์บน host นอกโฟลเดอร์ repo ตั้ง path ด้วย `GITHUB_APP_PRIVATE_KEY_PATH` ใน `.env`
  - bind-mount แบบ read-only ไปที่ `/run/secrets/github-app.pem` ของ worker
  - ห้ามเข้า container `web` ห้ามลง DB, log, audit หรือข้อความ error
- **web ไม่เรียก GitHub API** และไม่ได้ private key ได้แค่ `GITHUB_WEBHOOK_SECRET` ผ่าน `environment:` ที่ระบุชื่อ
- **webhook**
  - ตรวจ `X-Hub-Signature-256` (`sha256=` + HMAC-SHA256 แบบ hex) ของ **raw body ไบต์ต่อไบต์** ด้วย `crypto.timingSafeEqual` ก่อน parse JSON ทุกครั้ง
  - route นี้ไม่ใช้ session และไม่ตรวจ `Origin` เพราะผู้ส่งคือ GitHub ไม่ใช่ browser ลายเซ็นจึงเป็นการยืนยันตัวตนอย่างเดียว
  - body เกิน 25 MiB → 413
- **installation token**
  - ขอใหม่ทุก deployment ด้วย `repositories: [<name>]`, `permissions: { contents: 'read' }` และไม่เก็บไว้ที่ไหน
  - ทุกข้อความที่อาจมี token (log, `failureReason`, console) ต้องผ่าน redact
- **GitHub API**
  - base `https://api.github.com`
  - headers `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`, `User-Agent: vpsm`
  - timeout 15 วินาทีต่อ request
  - JWT RS256 payload `{ iat: now − 60, exp: now + 540, iss: String(appId) }`
- **เมื่อยังไม่ได้ตั้งค่า**
  - ไม่ตั้ง `GITHUB_APP_ID`: ไม่มี App, clone แบบไม่มี credential (repo public เท่านั้น) เหมือนเดิม
  - ไม่ตั้ง `GITHUB_WEBHOOK_SECRET`: webhook ตอบ 503
- **เลิกรองรับ `GITHUB_TOKEN`** ออกจาก config, pipeline, compose, docs และ `.env.example`
- **จับคู่ push กับ service**
  - `owner/name` ไม่สนตัวพิมพ์เล็กใหญ่ ส่วน branch ต้องตรงทุกตัวอักษร
  - ref ต้องขึ้นต้น `refs/heads/` และข้าม push ที่ `deleted: true`
  - deploy commit `after` ของ payload ตรงตัว (spec 5.3 ข้อ 2)
- **audit**
  - deployment จาก push → action `deployment.push`, `actorId: null`, metadata `{ project, service, repo, branch, commitSha, sender }`
  - admin กด Sync → `github.sync`
- UI ภาษาอังกฤษ docs ภาษาไทย

## Review Focus

1. **request ที่ไม่ได้มาจาก GitHub** (ไม่มีลายเซ็น, secret ผิด, body ถูกแก้แม้ไบต์เดียว, JSON เดิมที่ serialize ใหม่) → 401 และไม่มี deployment เข้าคิว → test ใน Task 5
2. **push ที่ไม่ควร deploy** (branch อื่น, tag `refs/tags/v1`, ลบ branch, repo ที่ไม่มี service ผูก) → 202 และไม่มี deployment → test ใน Task 5
3. **ชื่อ repo ต่างตัวพิมพ์** (`ITX-Insee/Web` กับ `itx-insee/web`), **branch มี `/`** (`feature/login`), **สอง service ผูก repo+branch เดียวกัน** → ทุก service ที่ตรงได้ deployment คนละหนึ่งอันพอดี → test ใน Task 1 และ Task 5
4. **App อ่าน repo ไม่ได้ / GitHub ล่ม / key ผิด**
   - repo ที่ App ไม่ได้ติดตั้ง: clone แบบไม่มี credential และบอกใน log
   - GitHub ตอบ error: deployment `FAILED` พร้อมเหตุผลที่อ่านรู้เรื่อง
   - token ไม่โผล่ใน log หรือ `failureReason`
   - key ผิด: worker ไม่ยอม boot พร้อมข้อความที่บอกว่าผิดตรงไหน

   → test ใน Task 2 และ Task 3
5. **push ซ้อนกันเร็วๆ** (push ใหม่ขณะตัวก่อนยัง `QUEUED` หรือกำลัง `BUILDING`) → ตัว `QUEUED` เก่าเป็น `SKIPPED`, ตัวที่ `BUILDING` ทำต่อจนจบ, commit ใหม่สุดเข้าคิวต่อ → test ใน Task 5

---

## File Structure

```
packages/db/migrations/0003_github.sql       # ตาราง github_repositories
packages/db/src/github.ts                    # รายชื่อ repo, หา service ที่ต้อง deploy, NOTIFY sync, สถานะ App/webhook ล่าสุด
apps/worker/src/github/app-client.ts         # JWT + GitHub API (installation token, รายชื่อ repo)
apps/worker/src/github/sync.ts               # sync รายชื่อ repo + สถานะลง DB และตัวตั้งเวลา
apps/worker/src/config.ts, main.ts, deploy/pipeline.ts
apps/web/src/server/github-webhook.ts        # ตรวจลายเซ็น + จัดการ event
apps/web/src/app/api/github/webhook/route.ts
apps/web/src/server/github.ts                # ข้อความสถานะ push ของ service + admin sync
apps/web/src/app/(app)/admin/github/page.tsx
apps/web/src/components/repo-datalist.tsx
docker-compose.yml, .env.example, docs/operations.md
```

---

### Task 1: ตาราง `github_repositories` และฟังก์ชัน DB

**Files:**
- Modify: `packages/db/src/schema.ts`, `packages/db/src/index.ts`
- Create: `packages/db/migrations/0003_*.sql` (`corepack pnpm --filter @vpsm/db exec drizzle-kit generate --name github`), `packages/db/src/github.ts`
- Test: `packages/db/test/github.test.ts`

**Interfaces:**
- Produces (schema): `github_repositories(id bigint {mode:'number'} pk /* id ของ repo ฝั่ง GitHub */, full_name text not null, default_branch text not null, private boolean not null, installation_id bigint {mode:'number'} not null, synced_at timestamptz not null default now())` + unique index `github_repositories_full_name_lower_idx` บน `lower(full_name)`; type `GithubRepository`
- Produces (`github.ts`):
  - `type GithubRepositoryInput = { id: number; fullName: string; defaultBranch: string; private: boolean; installationId: number }`
  - `replaceGithubRepositories(db: Db, repos: GithubRepositoryInput[]): Promise<void>` — ลบทั้งหมดแล้ว insert ใหม่ใน transaction เดียว
  - `listGithubRepositories(db: Db): Promise<GithubRepository[]>` — เรียงตาม `lower(full_name)`
  - `findGithubRepository(db: Db, fullName: string): Promise<GithubRepository | null>` — ไม่สนตัวพิมพ์
  - `type PushTarget = { instanceId: string; projectName: string; serviceName: string }`
  - `findPushTargets(db: Db, i: { repo: string; branch: string }): Promise<PushTarget[]>` — instance ที่ `lower(source->>'repo') = lower(repo)` และ `source->>'branch' = branch` เรียงตาม project แล้ว service
  - `GITHUB_SYNC_CHANNEL = 'vpsm_github_sync'`, `requestGithubSync(db: Db): Promise<void>` (pg_notify payload `''`)
  - `GITHUB_KEYS = { status: 'githubStatus', lastWebhook: 'githubLastWebhook' } as const` (แถวใน `settings`, `updatedBy: null`)
  - `type GithubStatus = { ok: boolean; checkedAt: string; appSlug?: string; installations?: { account: string; repositories: number }[]; error?: string }`
  - `setGithubStatus(db, s: GithubStatus): Promise<void>`, `getGithubStatus(db): Promise<GithubStatus | null>` — ค่าที่เก็บไว้ผิดรูป → `null`
  - `type WebhookDelivery = { event: string; deliveryId: string | null; receivedAt: string; outcome: string }`
  - `recordWebhookDelivery(db, d: WebhookDelivery): Promise<void>`, `getLastWebhookDelivery(db): Promise<WebhookDelivery | null>`

- [ ] **Step 1: เขียน test ที่ fail**

```ts
// packages/db/test/github.test.ts — service a: 'ITX-Insee/Web'@main, b: 'itx-insee/web'@feature/login, c: 'itx-insee/web'@Main
test('findPushTargets matches owner/name in any letter case and the branch exactly', async () => {
  expect(await findPushTargets(db, { repo: 'itx-insee/web', branch: 'main' })).toEqual([{ instanceId: a.instance.id, projectName: 'p', serviceName: 'a' }])
  expect((await findPushTargets(db, { repo: 'ITX-INSEE/WEB', branch: 'feature/login' })).map((t) => t.serviceName)).toEqual(['b'])
})
test('two services on the same repo and branch are both targets', /* d: 'itx-insee/web'@main in another project → [a, d] */)
test('a service without a source is never a target')
test('replaceGithubRepositories swaps the whole list', /* [x, y] then [y] → listGithubRepositories = [y] */)
test('findGithubRepository ignores letter case')
test('requestGithubSync notifies GITHUB_SYNC_CHANNEL', /* sql.listen receives one notification */)
test('github status and last webhook round-trip, and a malformed stored value reads as null')
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project db test/github.test.ts` → FAIL
- [ ] **Step 3: เขียน schema + `github.ts` ตาม Interfaces แล้ว generate migration**
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run --project db` → PASS
- [ ] **Step 5: Commit** — `feat(db): github repositories, push targets, sync channel and status`

---

### Task 2: GitHub App client ใน worker

**Files:**
- Create: `apps/worker/src/github/app-client.ts`
- Modify: `apps/worker/src/config.ts`
- Test: `apps/worker/test/github-app-client.test.ts`, `apps/worker/test/config.test.ts`

**Interfaces:**
- Consumes: `GithubRepositoryInput` (Task 1)
- Produces (config):
  - `WorkerConfig.githubApp?: { appId: number; privateKeyFile: string }` อ่านจาก `GITHUB_APP_ID` (จำนวนเต็มบวก) และ `GITHUB_APP_PRIVATE_KEY_FILE` (absolute path, ค่าเริ่มต้น `/run/secrets/github-app.pem`)
  - ลบ `githubToken` / `GITHUB_TOKEN` ทิ้ง ถ้ายังมี `GITHUB_TOKEN` ใน env ก็ถูกเพิกเฉยเหมือนตัวแปรอื่นที่ไม่รู้จัก
- Produces (`app-client.ts`):
  - `class GithubApiError extends Error { constructor(message: string, readonly status: number | null) }` — message เป็น `GitHub API <METHOD> <path>: <status> <message จาก body หรือ statusText>` หรือ `GitHub API <METHOD> <path>: <สาเหตุ>` เมื่อ network ล่มหรือ timeout ไม่มี token หรือ JWT อยู่ใน message
  - `createAppJwt(appId: number, key: KeyObject, nowSec: number): string`
  - `type GithubAppClient = { app(): Promise<{ slug: string }>; repositoryToken(repo: string): Promise<string | null>; listRepositories(): Promise<{ installations: { id: number; account: string }[]; repositories: GithubRepositoryInput[] }> }`
  - `createGithubAppClient(o: { appId: number; privateKey: KeyObject; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }): GithubAppClient`
    - `repositoryToken('owner/name')`:
      1. GET `/repos/owner/name/installation` ด้วย JWT ถ้าได้ 404 → คืน `null`
      2. POST `/app/installations/{id}/access_tokens` body `{ repositories: ['name'], permissions: { contents: 'read' } }` → คืน `token`
    - `app()`: GET `/app` → `{ slug }`
    - `listRepositories()`:
      1. GET `/app/installations?per_page=100&page=n` ไล่ไปจนได้หน้าที่มีไม่ถึง 100
      2. ทุก installation: POST access_tokens (ไม่ส่ง body) แล้ว GET `/installation/repositories?per_page=100&page=n` ไล่ไปจนครบ `total_count`
  - `loadGithubAppKey(file: string, readFile?: (file: string) => Promise<Buffer>): Promise<KeyObject>`
    - ไฟล์ว่าง → error `GitHub App private key at <file> is empty (set GITHUB_APP_PRIVATE_KEY_PATH in .env)`
    - ไม่ใช่ RSA private key → `GitHub App private key at <file> is not a valid RSA private key`
    - ห้ามมีเนื้อหาไฟล์อยู่ในข้อความ

- [ ] **Step 1: เขียน test ที่ fail**

```ts
// apps/worker/test/github-app-client.test.ts
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
test('createAppJwt is an RS256 JWT for the app, valid 9 minutes and back-dated 60 s', () => {
  const [h, p, s] = createAppJwt(5435849, privateKey, 1_700_000_000).split('.')
  expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
  expect(JSON.parse(Buffer.from(p!, 'base64url').toString())).toEqual({ iat: 1_699_999_940, exp: 1_700_000_540, iss: '5435849' })
  expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, 'base64url'))).toBe(true)
})
test('repositoryToken asks for a read-only token of that one repository', /* fake fetch: records URL, method, body,
  Authorization 'Bearer <jwt>', Accept, X-GitHub-Api-Version '2022-11-28', User-Agent 'vpsm'; returns { token: 'ghs_x' } */)
test('repositoryToken is null when the app is not installed on the repository (404)')
test('a GitHub error names the call and the status, never the token or the JWT', async () => {
  // access_tokens answers 403 { message: 'Resource not accessible by integration' }
  await expect(client.repositoryToken('acme/web')).rejects.toThrow(
    'GitHub API POST /app/installations/7/access_tokens: 403 Resource not accessible by integration')
})
test('listRepositories follows the pages of installations and of repositories', /* 2 installations, the 2nd with 150 repos in 2 pages */)
test('a request slower than timeoutMs fails with a GithubApiError', /* timeoutMs: 50, fetch that honours the signal */)
test('loadGithubAppKey refuses an empty file and a file that is not a private key, without printing either')
// apps/worker/test/config.test.ts
test('GITHUB_APP_ID turns the app on with the default key path; a non-numeric id is refused; GITHUB_TOKEN is not read')
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project worker test/github-app-client.test.ts test/config.test.ts` → FAIL
- [ ] **Step 3: เขียนโค้ดตาม Interfaces** (`crypto.sign('RSA-SHA256', …)`, base64url; `AbortSignal.timeout(timeoutMs)`; เอา test ของ `githubToken` ใน config.test.ts ออก)
- [ ] **Step 4: Run ให้ผ่าน** — คำสั่งเดิม → PASS
- [ ] **Step 5: Commit** — `feat(worker): github app client with per-repository installation tokens`

---

### Task 3: pipeline clone ด้วย installation token

**Files:**
- Modify: `apps/worker/src/deploy/pipeline.ts`, `apps/worker/src/main.ts`, `apps/worker/test/fakes.ts`
- Test: `apps/worker/test/pipeline.test.ts` (แทนที่ test ทั้ง 3 จุดที่ใช้ `githubToken`)

**Interfaces:**
- Consumes: `GithubAppClient`, `GithubApiError`, `loadGithubAppKey`, `createGithubAppClient` (Task 2)
- Produces:
  - `PipelineDeps.github?: Pick<GithubAppClient, 'repositoryToken'>` ถ้าไม่มี App ก็เป็น `undefined`
  - `Job` เก็บ secret เป็นรายการที่เพิ่มได้ และ `redact` แทนที่ทุกตัวที่เก็บไว้จนถึงขณะนั้น token ต้องถูกเพิ่มทันทีที่ได้มา ก่อนนำไปใช้ที่ใด `closeLog` ใช้ `job.redact`
- `buildPhase` เขียน log บรรทัดแรกตามกรณี:
  - ไม่มี `deps.github` → `==> Cloning <repo>@<branch> (no GitHub App: public repositories only)` แล้ว clone แบบไม่มี token
  - ได้ token `null` → `==> Cloning <repo>@<branch> (the GitHub App is not installed on this repository: public repositories only)`
  - ได้ token → `==> Cloning <repo>@<branch> with the GitHub App` แล้วใช้ `githubCloneUrl(repo, token)` และ `redact: [token]`
  - `GithubApiError` → `DeploymentFailure('could not get access to <repo> from GitHub: <message>')`
- `main.ts` (ใน `prepare`): ถ้ามี `config.githubApp` ให้เรียก `loadGithubAppKey` แล้ว `createGithubAppClient` ถ้า key ผิดให้ boot ล้มพร้อมข้อความนั้น เพื่อให้เห็นทันทีใน `docker compose logs worker` ตอน boot ห้ามเรียก GitHub API (GitHub ล่มต้องไม่ทำให้ worker เริ่มไม่ได้)

- [ ] **Step 1: เขียน test ที่ fail**

```ts
test('clones with an installation token of the repository and never logs it', /* deps.github.repositoryToken: 'acme/web' → 'ghs_secret';
  cloneUrl 'https://x-access-token:ghs_secret@github.com/acme/web.git', redact ['ghs_secret']; log has
  '==> Cloning acme/web@main with the GitHub App', '***' where git/railpack/buildx printed the token, and never 'ghs_secret' */)
test('a repository the app is not installed on is cloned without credentials, and the log says so')
test('without a GitHub App it clones without credentials')
test('a GitHub error fails the deployment with a readable reason', async () => {
  // repositoryToken throws new GithubApiError('GitHub API POST /app/installations/7/access_tokens: 403 Resource not accessible by integration', 403)
  expect(row).toMatchObject({ status: 'FAILED', failureReason:
    'could not get access to acme/web from GitHub: GitHub API POST /app/installations/7/access_tokens: 403 Resource not accessible by integration' })
})
test.each(['source error', 'unexpected error'])('the installation token never reaches the failure reason (%s)')
test('failing to close the log is reported without the installation token')
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project worker test/pipeline.test.ts` → FAIL
- [ ] **Step 3: แก้ pipeline + main + fakes ตาม Interfaces**
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run --project worker` → PASS และ `corepack pnpm -r exec tsc --noEmit` สะอาด
- [ ] **Step 5: Commit** — `feat(worker): clone with a github app installation token instead of GITHUB_TOKEN`

---

### Task 4: sync รายชื่อ repo และสถานะของ App

**Files:**
- Create: `apps/worker/src/github/sync.ts`
- Modify: `apps/worker/src/main.ts`
- Test: `apps/worker/test/github-sync.test.ts`

**Interfaces:**
- Consumes: Task 1 (`replaceGithubRepositories`, `setGithubStatus`, `GITHUB_SYNC_CHANNEL`), Task 2 (`GithubAppClient`)
- Produces:
  - `syncGithub(db: Db, client: GithubAppClient, now?: () => Date): Promise<GithubStatus>` — ไม่ throw เลย
    - สำเร็จ: เรียก `app()` + `listRepositories()` → `replaceGithubRepositories` แล้ว `setGithubStatus({ ok: true, checkedAt, appSlug, installations: [{ account, repositories: <จำนวน> }] })`
    - ล้มเหลว: `setGithubStatus({ ok: false, checkedAt, error: <message> })` และ **เก็บรายชื่อเดิมไว้** (GitHub ล่มต้องไม่ทำให้ช่องเลือก repo ว่าง)
    - DB ล้มตอนเขียนสถานะ: log แล้วไปต่อ
  - `startGithubSync(deps: { db: Db; client: GithubAppClient; listen: DeployLoopDeps['listen'] }, signal: AbortSignal, intervalMs?: number /* 10 * 60_000 */): Promise<void>`
    - sync ทันที, ทุกครั้งที่ได้ NOTIFY บน `GITHUB_SYNC_CHANNEL`, และทุก `intervalMs`
    - ไม่รันซ้อนกัน: คำขอที่เข้ามาระหว่างรัน = รันเพิ่มอีกหนึ่งรอบหลังรอบนั้นจบ
    - แยกจาก deploy loop (ไม่รอ build)
    - resolve หลัง `signal` abort เมื่อรอบที่กำลังรันจบ
  - `main.ts`: เริ่มเฉพาะเมื่อมี App, หยุดพร้อม deploy loop ตอน shutdown

- [ ] **Step 1: เขียน test ที่ fail**

```ts
test('a sync stores the repositories and an ok status with the app slug and the count per installation')
test('a failed sync records the error and keeps the previous list')
test('it syncs at start, on a NOTIFY and on the interval, and never runs two syncs at once', /* fake listen + vi fake timers;
  listRepositories blocks on a deferred; 3 requests during the run → exactly 1 more run */)
test('after abort it stops listening and settles once the running sync ends')
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project worker test/github-sync.test.ts` → FAIL
- [ ] **Step 3: เขียนโค้ดตาม Interfaces และต่อสายใน `main.ts`**
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run --project worker` → PASS
- [ ] **Step 5: Commit** — `feat(worker): sync the repositories the github app can read`

---

### Task 5: webhook endpoint ใน web

**Files:**
- Modify: `apps/web/src/server/config.ts`, `apps/web/src/proxy.ts`, `apps/web/e2e/global-setup.ts`, `apps/web/e2e/smoke.spec.ts`
- Create: `apps/web/src/server/github-webhook.ts`, `apps/web/src/app/api/github/webhook/route.ts`
- Test: `apps/web/test/github-webhook.test.ts`, `apps/web/test/config.test.ts`, `apps/web/test/proxy.test.ts`

**Interfaces:**
- Consumes: Task 1 (`findPushTargets`, `requestGithubSync`, `recordWebhookDelivery`), `enqueueDeployment`, `auditBestEffort`, `logServerError`, `GENERIC_ERROR`
- Produces:
  - `WebConfig.githubWebhookSecret?: string` อ่านจาก `GITHUB_WEBHOOK_SECRET` ยาวอย่างน้อย 16 ตัว (`must be at least 16 characters`)
  - `MAX_WEBHOOK_BYTES = 25 * 1024 * 1024`
  - `verifyGithubSignature(secret: string, body: Uint8Array, header: string | null): boolean`
  - `type WebhookInput = { secret: string | undefined; event: string | null; deliveryId: string | null; signature: string | null; body: Uint8Array }`
  - `handleGithubWebhook(db: Db, i: WebhookInput): Promise<{ status: number; body: Record<string, unknown> }>` เรียงตามลำดับ:

    | เงื่อนไข | ผลลัพธ์ |
    | --- | --- |
    | ไม่มี secret | 503 `{ error: 'GitHub integration is not configured' }` |
    | ลายเซ็นไม่มีหรือไม่ตรง | 401 `{ error: 'invalid signature' }` |
    | body ไม่ใช่ JSON | 400 `{ error: 'invalid JSON' }` |
    | `ping` | 200 `{ ok: true }` |
    | `installation` / `installation_repositories` | `requestGithubSync` → 202 `{ sync: 'requested' }` |
    | `push` ที่ payload ผิดรูป | 400 `{ error: 'unexpected push payload' }` |
    | `push` ที่ ref ไม่ขึ้นต้น `refs/heads/` | 202 `{ ignored: 'not a branch' }` |
    | `push` ที่ `deleted` | 202 `{ ignored: 'branch deleted' }` |
    | `push` ปกติ | enqueue + audit ต่อ target → 202 `{ queued: <n> }` |
    | event อื่น | 202 `{ ignored: '<event>' }` |

    - push ปกติ: target ที่ enqueue ไม่สำเร็จให้ log แล้วข้ามไป target อื่นยังเข้าคิวต่อ
    - ทุก delivery ที่ลายเซ็นถูก → `recordWebhookDelivery({ event, deliveryId, receivedAt, outcome: '<status> <สรุปสั้น>' })` แบบ best effort
  - push payload ที่รับ: `{ ref: string; after: /^[0-9a-f]{40}$/; deleted?: boolean; repository: { full_name: <owner/name> }; head_commit?: { message: string } | null; sender?: { login: string } }`
    - `commitMessage` = บรรทัดแรกของ `head_commit.message` ตัดที่ 200 ตัวอักษร
    - `createdById` ไม่ใส่
  - route `POST`:
    1. `Content-Length` เกิน max → 413 ก่อนอ่าน body; อ่าน stream เกิน max → 413
    2. เรียก `handleGithubWebhook` แล้วตอบ `Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })`
    3. error อื่น → `logServerError` + 500 `GENERIC_ERROR`
  - `proxy.ts` matcher ต้องไม่ครอบ `/api/github/webhook` (proxy ไม่มีงานกับ route นี้ และ Next จะได้ไม่ต้อง buffer body ก่อนตรวจลายเซ็น)

- [ ] **Step 1: เขียน test ที่ fail**

```ts
// apps/web/test/github-webhook.test.ts — service 'web' in project 'p' bound to 'itx-insee/web'@main
const secret = 'test-webhook-secret-0123456789'
const sign = (body: string) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
const pushBody = (over: object = {}) => JSON.stringify({ ref: 'refs/heads/main', after: 'a'.repeat(40),
  repository: { full_name: 'itx-insee/web' }, head_commit: { message: 'fix login\n\nmore' }, sender: { login: 'dev1' }, ...over })
test('a push queues a deployment of that commit for each bound service and audits it', async () => {
  expect(await deliver('push', pushBody())).toEqual({ status: 202, body: { queued: 1 } })
  expect(await deploymentsOf(web)).toMatchObject([{ trigger: 'push', status: 'QUEUED', commitSha: 'a'.repeat(40), commitMessage: 'fix login', createdById: null }])
  // audit: action 'deployment.push', actorId null, metadata { project: 'p', service: 'web', repo: 'itx-insee/web', branch: 'main', commitSha, sender: 'dev1' }
})
test.each(['no signature', 'another secret', 'body changed after signing', 'same JSON with other spacing'])('%s → 401 and nothing queued')
test('without a configured secret every delivery is 503')
test.each([[{ ref: 'refs/tags/v1' }, { ignored: 'not a branch' }], [{ deleted: true, after: '0'.repeat(40) }, { ignored: 'branch deleted' }],
  [{ ref: 'refs/heads/dev' }, { queued: 0 }]])('%j → 202 %j and nothing queued')
test('the repository name in another letter case and a branch with a slash still deploy')
test('a push while one is queued skips that one; a push while one is building queues behind it')
test('ping is 200; installation events request a sync; other events are ignored')
test('every signed delivery is remembered as the last webhook; unsigned ones are not')
test('malformed JSON is 400 and a push without a repository is 400')
test('the route answers 413 to a body over 25 MiB without reading it')
// apps/web/test/proxy.test.ts
test('the session proxy runs for pages but never for the GitHub webhook', /* new RegExp(`^${config.matcher[0]}$`) */)
// e2e/smoke.spec.ts: a signed push for the smoke test's service → 202 { queued: 1 }, and its page then lists a "Push" deployment
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project web test/github-webhook.test.ts test/config.test.ts test/proxy.test.ts` → FAIL
- [ ] **Step 3: เขียนโค้ดตาม Interfaces** (global-setup ส่ง `GITHUB_WEBHOOK_SECRET` ให้ server ของ e2e)
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run --project web` → PASS และ `E2E=1 corepack pnpm --filter @vpsm/web exec playwright test` → PASS
- [ ] **Step 5: Commit** — `feat(web): github webhook queues push deployments`

---

### Task 6: UI — เลือก repo, สถานะ push, หน้า Admin GitHub

**Files:**
- Create: `apps/web/src/server/github.ts`, `apps/web/src/components/repo-datalist.tsx`, `apps/web/src/app/(app)/admin/github/page.tsx`, `apps/web/src/app/(app)/admin/github/sync-form.tsx`
- Modify:
  - `apps/web/src/server/actions/admin.ts` (+ `requestGithubSyncAction`), `apps/web/src/app/(app)/admin/layout.tsx` (ลิงก์ "GitHub")
  - `apps/web/src/app/(app)/projects/[project]/page.tsx`, `new-service-form.tsx`
  - `apps/web/src/app/(app)/projects/[project]/services/[service]/page.tsx`, `settings-form.tsx`
- Test: `apps/web/test/github-ui.test.ts`, `apps/web/test/admin-action-wrappers.test.ts`

**Interfaces:**
- Consumes: Task 1 (`listGithubRepositories`, `findGithubRepository`, `getGithubStatus`, `getLastWebhookDelivery`, `requestGithubSync`), `webConfig().githubWebhookSecret`, `panelOrigin`
- Produces:
  - `pushDeployNote(i: { source: SourceConfig | null; status: GithubStatus | null; repository: GithubRepository | null }): { tone: 'ok' | 'warning'; text: string } | null`

    | เงื่อนไข | ผลลัพธ์ |
    | --- | --- |
    | ไม่มี source | `null` |
    | ไม่มี status | warning `The GitHub App is not set up: pushes do not deploy this service.` |
    | ไม่มี repository | warning `` `The GitHub App cannot read ${repo}: pushes do not deploy it, and it builds only if the repository is public.` `` |
    | อื่นๆ | ok `` `Every push to ${branch} deploys this service.` `` |

  - `doRequestGithubSync(db: Db, actor: Actor): Promise<ActionState>`
    - เรียก `requestGithubSync` แล้ว audit `{ action: 'github.sync', targetType: 'github' }`
    - คืน notice `Sync requested. The list updates within a minute.`
    - action wrapper เริ่มด้วย `beginAdminAction()` ตาม pattern เดิม
  - `RepoDatalist({ id, repositories })` render `<datalist id>` ที่มี `<option value={fullName}>default branch {defaultBranch}</option>` และช่อง repo ของทั้งสองฟอร์มใส่ `list="github-repositories"` (พิมพ์เองได้เหมือนเดิม และต้องใช้ได้โดยไม่มี JS)
- ข้อความใหม่ (ตรงตัวอักษร):
  - hint ช่อง repo: `A GitHub repository, as owner/name. Repositories the GitHub App can read are suggested.`
  - hint ช่อง branch ฟอร์มสร้าง: `Empty means main. Every push to this branch deploys the service when the GitHub App can read the repository.`
  - hint ช่อง branch ฟอร์มค่าตั้ง: `Every push to this branch deploys the service when the GitHub App can read the repository.`
  - ข้างปุ่ม "Save without deploying" (spec 5.2): `The running deployment is left as it is. The next deploy, including one started by a push, will include these settings.`
- หน้า service แสดง `pushDeployNote` ใต้หัวเรื่อง โทน warning ใช้ `Alert`
- หน้า `/admin/github` แสดง:
  - Webhook URL `${panelOrigin}/api/github/webhook` และบอกว่าตั้ง `GITHUB_WEBHOOK_SECRET` แล้วหรือยัง
  - สถานะ App: slug, ok หรือ error, เวลาตรวจ, installation พร้อมจำนวน repo (ไม่มีสถานะ → `Not set up: the worker has no GITHUB_APP_ID.`)
  - webhook ล่าสุด: event, delivery id, เวลา, outcome (ไม่มี → `No webhook received yet.`)
  - ตาราง repo (full name, default branch, private)
  - ปุ่ม "Sync now"

- [ ] **Step 1: เขียน test ที่ fail**

```ts
test.each([/* 4 rows of the table above, exact text */])('pushDeployNote: %s')
test('requesting a sync notifies the worker and is audited', /* listen on GITHUB_SYNC_CHANNEL; audit row github.sync */)
// admin-action-wrappers.test.ts: requestGithubSyncAction refuses a member and a foreign Origin like the other admin actions
```

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project web test/github-ui.test.ts test/admin-action-wrappers.test.ts` → FAIL
- [ ] **Step 3: เขียนโค้ดตาม Interfaces** (ห้าม `.bind()` ในไฟล์ที่เรียก `useActionState`: test โครงสร้างของ Plan 2 ยังต้องผ่าน)
- [ ] **Step 4: Run ให้ผ่าน** — `corepack pnpm vitest run --project web` → PASS, `corepack pnpm --filter @vpsm/web build` ผ่าน
- [ ] **Step 5: Commit** — `feat(web): repository suggestions, push status and github admin page`

---

### Task 7: compose, `.env.example` และคู่มือ

**Files:**
- Modify: `docker-compose.yml`, `.env.example`, `docs/operations.md`
- Test: `apps/worker/test/compose.test.ts`

**Interfaces:**
- `worker.volumes` + `${GITHUB_APP_PRIVATE_KEY_PATH:-/dev/null}:/run/secrets/github-app.pem:ro` (ไม่ได้ตั้ง path = ไฟล์ว่าง ซึ่ง worker ไม่อ่านเลยถ้าไม่มี `GITHUB_APP_ID`)
- `web.environment` + `GITHUB_WEBHOOK_SECRET: ${GITHUB_WEBHOOK_SECRET:-}`
- `.env.example`: ลบส่วน `GITHUB_TOKEN` ออก แล้วเพิ่ม:

```
# GitHub App (docs/operations.md, "GitHub App"). Leave GITHUB_APP_ID empty to build public repositories only.
GITHUB_APP_ID=
# Path ON THIS SERVER to the App's private key (.pem), outside this folder, chmod 600. Mounted read-only into the worker only.
GITHUB_APP_PRIVATE_KEY_PATH=
# The App's webhook secret (openssl rand -hex 32). Only the dashboard gets it.
GITHUB_WEBHOOK_SECRET=
```

- [ ] **Step 1: เขียน test ที่ fail**

```ts
test('web gets the webhook secret and nothing of the app key', () => {
  expect(Object.keys(web.environment ?? {})).toContain('GITHUB_WEBHOOK_SECRET')
  expect(web.environment?.GITHUB_WEBHOOK_SECRET).toBe('${GITHUB_WEBHOOK_SECRET:-}')
  const text = JSON.stringify(web)
  for (const secret of ['GITHUB_APP_PRIVATE_KEY_PATH', 'github-app.pem', 'GITHUB_APP_ID', 'POSTGRES_PASSWORD', 'ACME_EMAIL', 'COMPOSE_FILE', 'DUCKDNS_TOKEN']) expect(text).not.toContain(secret)
})
test('only the worker mounts the app key, read-only', /* worker.volumes has '${GITHUB_APP_PRIVATE_KEY_PATH:-/dev/null}:/run/secrets/github-app.pem:ro'; no other service mentions github-app.pem */)
```
(แก้ test เดิมที่ล็อกรายชื่อ env ของ web ให้มี `GITHUB_WEBHOOK_SECRET` และเอา `GITHUB_TOKEN` ออกจากรายการตรวจ)

- [ ] **Step 2: Run ให้ fail** — `corepack pnpm vitest run --project worker test/compose.test.ts` → FAIL
- [ ] **Step 3: แก้ compose และ `.env.example`**
- [ ] **Step 4: เขียน `docs/operations.md`** (ภาษาไทย) หัวข้อใหม่ "GitHub App":
  1. **สร้าง App** ใน org ของทีม
     - Homepage `https://<PANEL_DOMAIN>[:port]`
     - Webhook URL `https://<PANEL_DOMAIN>[:port]/api/github/webhook` + secret, เปิด SSL verification
     - Repository permissions: Contents = Read-only, Metadata = Read-only
     - Event: Push
     - ติดตั้งได้เฉพาะ account นี้
  2. **ติดตั้ง App** แบบ Only select repositories
  3. **Private key:** เมนู Credentials → Generate a private key แล้วเก็บไฟล์บน VPS นอกโฟลเดอร์ repo (ตัวอย่าง `/var/opt/vps-engine/secrets/github-app.pem`, โฟลเดอร์ 700, ไฟล์ 600)
     - ย้ายไฟล์ด้วย `pbcopy` / Droplet Console และ**ห้ามเปิดไฟล์ใน editor ที่มี AI assistant**
     - ตรวจ fingerprint ด้วย `openssl rsa -in … -pubout -outform DER | openssl sha256 -binary | openssl base64`
  4. **ใส่ค่าใน `.env`:** `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_SECRET` แล้วรัน `docker compose up -d`
  5. **IP allow list ของ org** (ถ้า org เปิดใช้): ต้องมี IP ขาออกของ VPS ทั้ง IPv4 และ IPv6 ดูได้ด้วย `curl -4 ifconfig.me`, `curl -6 ifconfig.me`
  6. **ตรวจว่าใช้ได้:** หน้า Admin → GitHub ต้องแสดง status ok, จำนวน repo และ webhook ล่าสุด และดู Recent Deliveries / Redeliver ใน GitHub
  7. **เปลี่ยน key:** สร้างอันใหม่ → เขียนทับไฟล์ → `docker compose restart worker` → ลบอันเก่าใน GitHub
  8. **revoke `GITHUB_TOKEN` เดิม** แล้วลบออกจาก `.env`

  และแก้ทุกบรรทัดที่พูดถึง `GITHUB_TOKEN` (ตาราง env, หัวข้อความปลอดภัย, รายการตัวแปรของ web) เพิ่มขั้น upgrade สำหรับระบบที่ติดตั้งแล้ว และเพิ่มข้อในรายการตรวจบน VPS: "push ขึ้น branch ที่ผูกไว้ → เวอร์ชันใหม่ขึ้นภายใน ~5 นาที โดยไม่ต้อง SSH"
- [ ] **Step 5: Run ทั้งหมด** — `corepack pnpm test` → PASS, `corepack pnpm -r exec tsc --noEmit` สะอาด
- [ ] **Step 6: Commit** — `feat(deploy): github app key for the worker, webhook secret for the panel, docs`
