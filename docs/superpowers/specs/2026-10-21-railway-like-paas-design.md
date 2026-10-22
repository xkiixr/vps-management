# VPS Management — PaaS แบบ Railway บน VPS ของตัวเอง

วันที่: 2026-10-21
ข้อมูลอ้างอิงจากการแกะ Railway: [docs/railway-reverse-engineering.md](../../railway-reverse-engineering.md)

> ป้ายกำกับในเอกสารนี้
> - **(ตัดสินใจแล้ว)** = เจ้าของโปรเจกต์ตัดสินใจเอง
> - **(ผู้ออกแบบเลือก)** = ผู้ออกแบบเลือกให้ เจ้าของโปรเจกต์ยังไม่ได้ทบทวนรายข้อ เปลี่ยนได้ถ้ามีเหตุผล
> - ข้อที่ไม่มีป้าย = ส่วนที่ต่อยอดจากสองข้อข้างบน

---

## 1. เจตนาและเหตุผล

ทีมอยากได้ระบบ deploy แอปแบบ Railway (push โค้ดแล้วเว็บขึ้นเอง, เพิ่ม database ได้ในคลิกเดียว, ดู log ได้, ได้ HTTPS อัตโนมัติ) รันบน VPS ของตัวเอง

เหตุผลมีสองข้อ **(ตัดสินใจแล้ว)**:
1. **ไม่อยากจ่ายค่า Railway** เสียแค่ค่า VPS
2. **อยากได้ระบบที่เป็นของตัวเอง** หมายถึงโค้ดที่ทีมเขียนเอง เข้าใจทุกส่วน แก้และเพิ่มอะไรก็ได้ ไม่ได้หมายถึงแค่ "รันบนเครื่องตัวเองแล้วคุมได้เอง" เจ้าของโปรเจกต์รู้แล้วว่ามี Coolify และ Dokploy ให้ใช้ฟรี แต่เลือกสร้างเอง

ข้อ 2 เป็นตัวตัดสินหลายเรื่อง: โค้ดต้องอ่านง่าย แยกส่วนชัด ใช้ภาษาที่ทีมถนัด และพึ่งของสำเร็จรูปเฉพาะชิ้นที่ไม่คุ้มเขียนเอง (Docker, BuildKit, Railpack, Traefik, Postgres)

## 2. ผู้ใช้และสิทธิ์

- ผู้ใช้คือ **ทีมงานภายในเท่านั้น** ยังไม่เปิดให้คนนอก **(ตัดสินใจแล้ว)**
- **ไม่มีหน้าสมัครสมาชิก** เจ้าของโปรเจกต์เป็นคนสร้างบัญชีให้ทีม **(ตัดสินใจแล้ว)**
- 2 บทบาท:
  - `admin`: จัดการ user (สร้าง ปิด รีเซ็ตรหัสผ่าน), ตั้งค่าระบบ, เห็นทุก project
  - `member`: สร้าง project และ deploy ได้ เห็นเฉพาะ project ที่ตัวเองเป็นเจ้าของหรือถูกเชิญ
- Project มีเจ้าของ และเชิญ member คนอื่นเข้าร่วมได้ แบบ project members ของ Railway ทุกคนใน project มีสิทธิ์เท่ากัน ยังไม่แยกสิทธิ์ย่อยใน v1 **(ผู้ออกแบบเลือก)**
- ล็อกอินด้วย email + รหัสผ่าน **(ผู้ออกแบบเลือก)**
- เชื่อม GitHub ผ่าน **GitHub App ตัวเดียว** ที่ admin ติดตั้งไว้กับ org ของทีม ทุกคนเลือก repo จาก App นั้น ไม่มีการเชื่อม GitHub รายคน **(ผู้ออกแบบเลือก)**
- member ทุกคน deploy ได้ทุก repo ที่ GitHub App เข้าถึง แปลว่าอ่านโค้ดของ repo เหล่านั้นได้ด้วย รวมถึง repo ของทีมอื่นใน org ไม่มีรายการ repo ที่อนุญาตต่อ project **(ตัดสินใจแล้ว — ยอมรับความเสี่ยงนี้)**
- บันทึก audit event ตั้งแต่ v1 (ใคร deploy/ลบ/แก้ตัวแปร/เพิ่ม user อะไร เมื่อไร) แต่หน้าดู audit log ทำใน v2

## 3. ขอบเขต

### 3.1 เป้าหมายของ v1 — "ทีมย้ายแอปจริงมาใช้ได้" (ตัดสินใจแล้ว)

1. ล็อกอิน + จัดการ user (admin/member)
2. Project ที่มี environment เดียวชื่อ `production` แต่โครงข้อมูลรองรับหลาย environment แล้ว (Project → Environment → Service แบบ Railway)
3. เพิ่ม service จาก GitHub repo + branch, push แล้ว build/deploy อัตโนมัติ, build ด้วย Railpack หรือ Dockerfile ถ้า repo มี
4. Deploy แบบไม่ล่ม: รอ healthcheck ผ่านก่อนสลับ traffic
5. Env vars ต่อ service + การอ้างอิง `${{Service.VAR}}`
6. Database: Postgres และ Redis แบบ template มี port สาธารณะให้ต่อจากเครื่องตัวเอง (ใช้ย้ายข้อมูลเก่าเข้ามา) และ backup Postgres อัตโนมัติทุกวัน เก็บ 7 วัน
7. โดเมน: URL อัตโนมัติ `<service>-<project>.<โดเมนแอป>`, เพิ่ม custom domain ได้, HTTPS อัตโนมัติ ลบโดเมนออกได้หมดเพื่อให้ service เป็นแบบภายในเท่านั้น (เช่น API ภายใน, worker, bot) **(ผู้ออกแบบเลือก)**
8. Log สดทั้งตอน build และตอนรัน, ประวัติ deploy, rollback, restart, redeploy
9. หน้า Canvas แบบ Railway (รายละเอียดข้อ 6)
10. จำกัด RAM/CPU ต่อ service โดยมีค่าเริ่มต้นให้
11. Volume สำหรับ service ทั่วไป (เช่น โฟลเดอร์รูปที่ผู้ใช้อัปโหลด) ย้ายมาจาก v2 **(ตัดสินใจแล้ว)** มี backup รายวันแบบเดียวกับ database **(ผู้ออกแบบเลือก)**

### 3.2 ไม่ทำใน v1 (Non-goals)

- **v2:** environment staging + PR environments, CLI แบบ `railway up`, cron jobs, replicas, กราฟ CPU/RAM, แจ้งเตือน deploy พังไป Discord/LINE/Slack, MySQL/Mongo, Postgres + pgvector, deploy จาก Docker image, หน้าดู audit log, watch patterns (deploy เฉพาะเมื่อไฟล์บาง path เปลี่ยน)
- **v3:** หลาย VPS ต่อกันด้วย WireGuard
- **ไม่ทำเลยในตอนนี้:** สมัครสมาชิกเอง, ระบบคิดเงิน, sandbox ระดับสูง (gVisor/microVM), หลาย region, sleep app เมื่อไม่มีคนใช้, ระบบ staged changes / config-as-code แบบ Railway

### 3.3 Anti-goals — ถือว่าล้มเหลวแม้ระบบจะทำงานได้

- แอปตัวเดียวหรือ build ตัวเดียวกินทรัพยากรจนทั้ง VPS ล่ม รวมถึง dashboard
- ข้อมูลใน database ของทีมหายโดยกู้คืนไม่ได้
- งานประจำ (deploy, ดู log, แก้ตัวแปร, เพิ่มโดเมน) ยังต้อง SSH เข้า VPS
- โค้ดซับซ้อนหรือ "ฉลาด" เกินจนทีมไม่กล้าแก้ ขัดกับเหตุผลข้อ 2
- member เห็นหรือแก้ project ที่ตัวเองไม่ได้เป็นสมาชิก
- ระบบเองพิมพ์ secret (รหัส database, API key) ลง log หรือแสดงให้คนที่ไม่มีสิทธิ์เห็น (ค่าที่โค้ดของทีมพิมพ์ออกมาเองไม่ถูกปิดบังใน v1 — ผู้ออกแบบเลือก)

### 3.4 เกณฑ์ความสำเร็จของ v1

- push โค้ดแอป Next.js/Node ขึ้น branch ที่ผูกไว้ แล้วเว็บเวอร์ชันใหม่ขึ้นบน HTTPS ภายใน ~5 นาที ไม่มีใคร SSH **(ผู้ออกแบบเลือกตัวเลข)**
- ระหว่าง deploy เวอร์ชันใหม่ เว็บเดิมยังตอบ request ได้ตลอด
- deploy ที่ healthcheck ไม่ผ่าน ไม่ทำให้เว็บเดิมล่ม และ dashboard บอกสาเหตุพร้อม log
- ย้าย Postgres เก่าเข้ามาได้ด้วย `pg_restore` ผ่าน port สาธารณะ
- กู้ Postgres จาก backup ของเมื่อวานได้ (ทดสอบจริงอย่างน้อยครั้งเดียว)

## 4. ข้อจำกัด

- **เครื่อง (ตัดสินใจแล้ว):** VPS 1 เครื่อง, Ubuntu, 4 vCPU, RAM 8 GB ทุกอย่างทั้งระบบควบคุมและแอปของทีมรันบนเครื่องนี้
- **ภาษา (ตัดสินใจแล้ว):** ทีมถนัด Next.js และ Node เลยใช้ TypeScript ทั้งระบบ
- **ไม่มีค่าใช้จ่ายเพิ่ม (ตัดสินใจแล้ว):** ใช้ซอฟต์แวร์ open-source ฟรีเท่านั้น
- **ติดตั้งด้วย `docker compose` (ผู้ออกแบบเลือก):** ตัวระบบเองติดตั้ง อัปเดต และย้ายเครื่องได้ด้วย compose file เดียว + ไฟล์ `.env`
- **โดเมน:** ต้องมีโดเมนที่ตั้ง DNS ได้ ให้ panel อยู่โดเมนหนึ่ง (เช่น `panel.example.com`) และแอปอยู่ใต้ wildcard แยก (เช่น `*.apps.example.com`) ชี้มาที่ IP ของ VPS ทั้งสองค่าตั้งผ่าน env ห้าม hardcode ห้ามใช้ชื่อ/โดเมน/แบรนด์ของ Railway
- **การติดตั้งจริงตอนนี้ (ตัดสินแล้ว 2026-10-22):** VPS ไม่มีโดเมนซื้อ ใช้ DuckDNS: แอปอยู่ที่ `*.itexcellence.duckdns.org` และ panel อยู่ที่ `panel.itexcellence.duckdns.org` ซึ่งเป็นโดเมนที่จดทะเบียนเดียวกัน (same-site) กับแอปของทีม เจ้าของโปรเจกต์เลือกเองแทนการแยกชื่อ DuckDNS → ต้องชดเชยด้วย: session cookie ชื่อขึ้นต้น `__Host-`, ทุก request ที่แก้ข้อมูลต้องตรวจ `Origin` ตรงกับ origin ของ panel แบบเป๊ะ (SameSite ป้องกันไม่ได้เพราะเป็น same-site), และชื่อ panel ห้ามถูกใช้เป็นโดเมนของแอป Traefik รันที่ port 8443 (port 80/443 เป็นของ Nginx Proxy Manager) ด้วย `docker-compose.dns-tls.yml`
- **งบ RAM (ผู้ออกแบบเลือก, ค่าประมาณ):** ระบบควบคุม (Postgres + web + worker + Traefik) ≲ 1 GB, build ที่กำลังรัน ≲ 2–3 GB, ที่เหลือ ~4 GB สำหรับแอปและ database ของทีม → **build ทีละงานเท่านั้น** และทุก container ของผู้ใช้ต้องมี memory limit
- **บังคับงบ RAM รวม (ผู้ออกแบบเลือก):** admin ตั้ง "งบ memory รวมของแอปผู้ใช้" (ค่าเริ่มต้น = RAM เครื่อง − 2.5 GB) และ "limit สูงสุดต่อ service" member เลือก limit ได้ไม่เกินค่าสูงสุดนั้น ก่อนเริ่ม deploy ระบบรวม limit ของทุก container ที่รันอยู่ + container ใหม่ (นับช่วงที่ตัวเก่าและตัวใหม่รันซ้อนกันด้วย) ถ้าเกินงบ **ปฏิเสธ deploy ทันที** พร้อมข้อความบอกว่าเกินเท่าไร ไม่เข้าคิวรอ ส่วนตัวระบบควบคุมตั้ง memory limit/reservation ของตัวเองแยกไว้ ไม่ให้แอปผู้ใช้แย่ง
- **Disk (ผู้ออกแบบเลือก):** ยังไม่รู้ขนาด disk ค่า retention (image ย้อนหลัง, build cache, backup ในเครื่อง, log) ตั้งค่าได้ dashboard แสดงการใช้ disk และเตือน admin เมื่อเกิน 80%

## 5. สถาปัตยกรรม

### 5.1 ส่วนประกอบ (ผู้ออกแบบเลือก — ทีมรับหลักการแล้ว)

```
                    Internet
                       │ 80/443                    30000-32767 (TCP, เฉพาะ DB ที่เปิด public)
                ┌──────▼──────┐                          │
                │   Traefik   │  HTTPS (Let's Encrypt)   │
                └──┬───────┬──┘                          │
     panel.example.com     *.apps.example.com            │
          │                     │                        │
  ┌───────▼───────┐     ┌───────▼────────────────────────▼──────┐
  │  web          │     │  container ของแอป/DB ผู้ใช้            │
  │  (Next.js)    │     │  network แยกต่อ project               │
  │  UI + API     │     └───────▲────────────────────────────────┘
  └───┬───────────┘             │ docker run / stop
      │ SQL (คิวงาน, ข้อมูล)    │
  ┌───▼───────────┐     ┌───────┴───────┐
  │ Postgres      │◄────┤ worker (Node) │── docker.sock + BuildKit (railpack frontend)
  │ (ของระบบ)     │     └───────────────┘
  └───────────────┘
```

| ส่วน | หน้าที่ | หมายเหตุ |
| --- | --- | --- |
| `apps/web` (Next.js) | Dashboard + API (route handlers/server actions), auth, รับ GitHub webhook, ส่ง log ไปหน้าเว็บด้วย SSE, ให้ Traefik ดึง config เส้นทาง | **ไม่มีสิทธิ์เข้า Docker socket** คุยกับ worker ผ่าน Postgres เท่านั้น |
| `apps/worker` (Node) | ทำงานในคิว: clone → railpack prepare → build → run → healthcheck → สลับ route → หยุดตัวเก่า; backup; เก็บ log | ตัวเดียวที่ถือ Docker socket (สิทธิ์เทียบเท่า root) ห้ามเปิด port สู่ภายนอก |
| `packages/*` | โค้ดร่วม: schema DB, type, ตัว resolve `${{…}}`, template database | |
| Postgres (ของระบบ) | ข้อมูลทั้งหมดของระบบ + คิวงาน (เช่น `pg-boss` หรือเทียบเท่า) + LISTEN/NOTIFY สำหรับ event สด | ไม่ใช้ Redis เพื่อลดชิ้นส่วน |
| Traefik | reverse proxy, ออกใบรับรอง Let's Encrypt (HTTP-01) ให้ทั้งซับโดเมนอัตโนมัติและ custom domain | |
| BuildKit + Railpack | สร้าง image จาก source โดยไม่ต้องมี Dockerfile | ใช้ BuildKit ใน Docker Engine (`docker buildx build` + `BUILDKIT_SYNTAX=ghcr.io/railwayapp/railpack-frontend`) ตามวิธีใน findings §4.7 |

**ไม่ใช้ image registry ใน v1 (ผู้ออกแบบเลือก):** เครื่องเดียว build เสร็จแล้ว image อยู่ใน Docker Engine เลย tag ด้วย deployment id เก็บ image ย้อนหลัง N ตัวต่อ service ไว้ rollback (ค่าเริ่มต้น N=5) ที่เหลือลบ (ข้อนี้ต่างจากที่เคยคุยกันว่าจะมี registry)

### 5.2 โมเดลข้อมูล (ยืมจาก Railway, findings §4.2)

```
User (email, passwordHash, role: admin|member, disabledAt)
Project (name, ownerId) ── ProjectMember (projectId, userId)
 └─ Environment (name)                  v1 มีแค่ "production" ต่อ project
     └─ ServiceInstance (= Service × Environment) ← ค่าตั้งทั้งหมดอยู่ตรงนี้
Service (projectId, name, kind: app|postgres|redis, canvasX, canvasY)
ServiceInstance
  source: { repo, branch, rootDirectory } | { template: postgres|redis, version }
  build:  { builder: auto|railpack|dockerfile, buildCommand?, dockerfilePath? }
  deploy: { startCommand?, healthcheckPath?, healthcheckTimeout, restartPolicy, memoryLimitMB, cpuLimit, port }
  variables: Variable[] (name, value เข้ารหัส, isGenerated)
  domains: Domain[] (hostname, kind: generated|custom, status, certStatus)
  publicTcp: { enabled, hostPort } (เฉพาะ database)
  volume: { name, mountPath, sizeLimit? } (ได้ทั้ง database และ service ทั่วไป, สูงสุด 1 volume ต่อ service ใน v1)
Deployment (serviceInstanceId, status, trigger: push|manual|rollback|config, commitSha, commitMessage,
            imageTag, configSnapshot JSON, createdById, startedAt, finishedAt, failureReason)
DeploymentLog (deploymentId, phase: build|deploy, ts, line) / หรือเก็บเป็นไฟล์ — ให้ผู้สร้างเลือก
Backup (serviceInstanceId, path, sizeBytes, createdAt, status)
AuditEvent (actorId, action, targetType, targetId, metadata, createdAt)
```

- **สถานะ Deployment:** ใช้ชุดย่อยของ Railway: `QUEUED → BUILDING → DEPLOYING → SUCCESS` และ `FAILED` (build/healthcheck ไม่ผ่าน), `CRASHED` (ผ่านแล้วแต่ตายจนเกิน restart limit), `REMOVED` (ถูกแทนที่หรือหยุด), `SKIPPED` (มี deploy ใหม่กว่าเข้าคิวมาทับก่อนเริ่ม)
- **`configSnapshot`:** ทุก deployment เก็บสำเนาค่าตั้งและตัวแปรที่ resolve แล้ว (ตัวแปรเข้ารหัสไว้) ที่ใช้จริงตอนนั้น rollback = รัน image เดิม + snapshot เดิม ไม่ build ใหม่
- **การแก้ค่าตั้งหรือตัวแปร (ผู้ออกแบบเลือก):** มีค่าตั้งชุดเดียวคือ "ค่าปัจจุบัน" ไม่มีระบบ draft ทุก deploy ทั้งจาก push, กดเอง และตอนแก้ค่า ใช้ค่าปัจจุบันเสมอ กดบันทึกแล้ว redeploy ทันทีเป็นค่าเริ่มต้น (เหมือน `skipDeploys=false` ของ Railway) มีตัวเลือก "บันทึกโดยยังไม่ deploy" ถ้าใช้ตัวเลือกนี้ Canvas จะแสดงแถบ "ค่าตั้งเปลี่ยนตั้งแต่ deploy ล่าสุด" และ push ครั้งถัดไปจะพาค่านั้นขึ้นไปด้วย ต้องเขียนบอกไว้ข้างตัวเลือกให้ชัด

### 5.3 การ deploy

1. **Trigger:** GitHub webhook `push` (ตรวจลายเซ็น webhook) → หา ServiceInstance ที่ผูก repo+branch นั้น → สร้าง Deployment `QUEUED` ถ้ามีงาน `QUEUED` ของ service เดียวกันค้างอยู่ ตัวเก่าเปลี่ยนเป็น `SKIPPED`
2. **ดึงโค้ด:** worker ใช้ installation token ของ GitHub App ดึงโค้ดตาม commit ที่ระบุ ลง directory ชั่วคราว (ถ้ามี `rootDirectory` ก็ใช้ path นั้น)
3. **Build (`BUILDING`):** มี `Dockerfile` (หรือเลือกไว้) ใช้ Dockerfile ไม่มีก็ใช้ `railpack prepare` (จัดการ exit 75 = retry, exit 1 = fail ทันที ตาม findings §4.7) แล้ว build ด้วย railpack frontend
   - ส่ง secret ผ่าน BuildKit `--secret` ห้ามเป็น build-arg ธรรมดา
   - ตั้ง `cache-key` ต่อ service
   - จำกัด build ทีละงานทั้งเครื่อง และมี timeout (ผู้สร้างกำหนดค่า เช่น 20 นาที)
4. **Run (`DEPLOYING`):** สร้าง container ใหม่จาก image + ตัวแปรที่ resolve แล้ว
   - inject `PORT` (ค่าเริ่มต้น 8080) และตัวแปรระบบแบบ Railway โดยใช้ prefix ของเราเอง เช่น `APP_PRIVATE_DOMAIN`, `APP_PUBLIC_DOMAIN`, `APP_SERVICE_NAME`, `APP_PROJECT_NAME`
   - ต่อเข้า network ของ project
   - ใส่ memory/CPU limit ตาม ServiceInstance
5. **Healthcheck:** ถ้าตั้ง `healthcheckPath` ต้องได้ HTTP 2xx ภายใน `healthcheckTimeout` ถ้าไม่ตั้งแต่ service มีโดเมน ต้องเปิดรับ TCP ที่ `PORT` ได้ และ container ยังไม่ตาย ถ้าไม่มีโดเมนเลย (worker/bot) ให้ถือว่าผ่านเมื่อ container ยังรันอยู่หลังผ่านไป 10 วินาที **(ผู้ออกแบบเลือก)**
6. **สลับ:** ผ่านแล้วอัปเดตเส้นทางให้ Traefik ชี้ไป container ใหม่ (ข้อ 5.4) รอ drain (ค่าเริ่มต้น 10 วินาที) แล้วหยุดตัวเก่า ตั้ง Deployment เก่าเป็น `REMOVED` ตัวใหม่เป็น `SUCCESS`
7. **ล้มเหลว:** ไม่แตะตัวเก่า ลบ container ใหม่ ตั้ง `FAILED` + `failureReason` + log ครบ
8. **หลังจากนั้น:** ถ้า container ตาย ให้ restart ตาม restart policy (Docker `on-failure` + max retries) ถ้าเกินขีดจำกัดตั้ง `CRASHED` ให้เห็นบน Canvas
9. **Database template:** ข้ามขั้น build ใช้ image ทางการ (เช่น `postgres:16`, `redis:7`) + named volume + ตัวแปรที่สร้างให้ (รหัสผ่านสุ่ม, `DATABASE_URL` ภายใน, `DATABASE_PUBLIC_URL` เมื่อเปิด public TCP) ตามแบบ findings §4.5 database ไม่ต้องทำ zero-downtime (หยุดตัวเก่าก่อนเริ่มตัวใหม่ เพราะใช้ volume เดียวกัน) Redis เปิด persistence แบบ AOF ลง volume แต่ยังไม่มี backup ใน v1 **(ผู้ออกแบบเลือก)**
10. **Postgres แบบ Railway (ตัดสินใจแล้ว: "ใช้ตาม Railway"):** ค่าเริ่มต้นเป็น Postgres major 18 ตามที่ Railway ใช้ตอนนี้ (findings: `ghcr.io/railwayapp-templates/postgres-ssl:18`) เปิด SSL ด้วย self-signed cert แบบ image `postgres-ssl` ของ Railway (`SSL_CERT_DAYS=820`) ชุดตัวแปรเหมือน findings §4.5 (`PGHOST`, `PGUSER`, `PGPASSWORD`, `DATABASE_URL`, `DATABASE_PUBLIC_URL` ฯลฯ) **(ผู้ออกแบบตีความ)** ทางที่ต้องการ: สร้าง image ของเราเองจาก `postgres:18` ทางการ + สคริปต์สร้าง cert แทนการดึง image ของ Railway ตรงๆ ระบบจะได้ไม่ผูกกับ registry ของคนอื่น ผู้สร้างเลือกได้ เลือก major version อื่นได้ตอนสร้าง (เปลี่ยนภายหลังไม่ได้ใน v1) ไม่มี extension พิเศษใน v1 Railway เองก็แยก pgvector เป็น template ต่างหาก
11. **Service ที่มี volume:** ห้ามรันตัวเก่ากับตัวใหม่ซ้อนกัน เพราะสองตัวเขียนไฟล์ชุดเดียวกันพร้อมกันอาจทำข้อมูลพัง ให้หยุดตัวเก่าก่อนแล้วค่อยเริ่มตัวใหม่ ยอมให้ล่มสั้นๆ ตอน deploy (Railway ก็ทำแบบนี้) dashboard ต้องบอกข้อนี้ตอนเพิ่ม volume **(ผู้ออกแบบเลือก)**

### 5.4 Network และโดเมน

- **Network แยกต่อ project (ผู้ออกแบบเลือก):** แต่ละ project (×environment) มี Docker network ของตัวเอง service ในนั้นเรียกกันด้วยชื่อ `<service>.internal` ผ่าน network alias (แทน `railway.internal`) project อื่นมองไม่เห็นกัน และ network ของระบบควบคุม (Postgres ของระบบ, worker) ไม่ต่อกับ network ของผู้ใช้
- **Traefik:** ต่อเข้า network ของ project ที่มีโดเมน เพื่อส่ง traffic ไปหา container
- **ที่มาของเส้นทาง (ผู้ออกแบบเลือก):** Traefik อ่าน config แบบ dynamic จาก endpoint ภายในของระบบ (HTTP provider) หรือไฟล์ที่ worker เขียน (file provider) **ไม่ใช้ Docker labels** เพราะต้องให้ระบบเป็นคนตัดสินใจว่าจะสลับเมื่อไร (หลัง healthcheck) ไม่ใช่ทันทีที่ container เกิด ผู้สร้างเลือกได้ว่าจะใช้ HTTP หรือ file provider
- **ใบรับรอง:** Let's Encrypt HTTP-01 รายโฮสต์ ทั้งซับโดเมนอัตโนมัติและ custom domain custom domain แสดงค่า DNS (CNAME/A) ที่ต้องตั้ง และสถานะการยืนยันใน dashboard
- **Public TCP สำหรับ database (ผู้ออกแบบเลือก):** ใช้ Docker publish port แบบสุ่มในช่วง 30000–32767 (Traefik TCP ต้องประกาศ port ล่วงหน้า ไม่เหมาะ) **ปิดเป็นค่าเริ่มต้น** เปิดปิดได้ต่อ database และใช้รหัสผ่านสุ่มยาวเสมอ

### 5.5 ตัวแปรและ secret

- เก็บ value เข้ารหัสใน Postgres (AES-256-GCM, master key จาก env ของระบบ) **(ผู้ออกแบบเลือก)**
- รูปแบบอ้างอิง: `${{VAR}}` = ตัวแปรใน service เดียวกัน, `${{Service.VAR}}` = ข้าม service ภายใน project เดียวกัน resolve ตอนสร้าง deployment ตรวจจับ reference วนและชื่อที่ไม่มีอยู่ แล้วแจ้ง error ก่อน build
- เส้นบน Canvas วาดจาก reference ข้าม service (A อ้าง B = เส้นจาก A ไป B)
- หน้าจอแสดง value แบบซ่อนไว้ กดเพื่อดูได้ ห้ามพิมพ์ value ลง build log หรือ log ของระบบ

### 5.6 Log

- **Build log:** worker เก็บทีละบรรทัดแล้วกระจายสดไปหน้าเว็บ (เช่นผ่าน Postgres LISTEN/NOTIFY → web → SSE) เก็บถาวรกับ Deployment
- **Runtime log:** มาจาก stdout/stderr ของ container ต้องดูสดได้ และย้อนหลังได้อย่างน้อยตั้งแต่ container ล่าสุดเริ่ม web ห้ามเข้า Docker socket เอง ผู้สร้างเลือกวิธีส่งต่อ (worker เปิด stream ภายใน หรือ worker เก็บลง DB พร้อม retention) แต่ต้องตั้ง log rotation ของ Docker ไม่ให้ disk เต็ม
- ทุก stream ต้องตรวจสิทธิ์ว่าผู้ชมเป็นสมาชิก project

### 5.7 Backup

- Postgres ของผู้ใช้: `pg_dump` วันละครั้งต่อ database เก็บ 7 วัน มีปุ่ม "backup ตอนนี้" และ "restore" ใน dashboard
- Volume ของ service ทั่วไป: เก็บเป็นไฟล์ archive วันละครั้ง เก็บ 7 วัน มีปุ่ม backup และ restore แบบเดียวกัน
- **Postgres ของระบบเอง** ต้อง backup แบบเดียวกัน
- โฟลเดอร์ backup อยู่บน disk เดียวกับ VPS ซึ่ง**ยังไม่ใช่ backup จริง** ต้องมีตัวเลือกส่งสำเนาไป S3-compatible ภายนอก (ตั้งค่าผ่าน env, ค่าเริ่มต้นปิด) และ dashboard ต้องเตือน admin ถ้ายังไม่ได้ตั้ง **(ผู้ออกแบบเลือก)**

### 5.8 ความปลอดภัยพื้นฐาน (ผู้ใช้ภายใน ไว้ใจได้ระดับหนึ่ง)

- container ของผู้ใช้: ไม่มี `--privileged`, ไม่ mount Docker socket, ไม่ mount path ของ host (ยกเว้น named volume ของตัวเอง), `no-new-privileges`, drop capabilities ที่ไม่จำเป็น, มี memory/CPU/PID limit
- ระบบควบคุมรันใน network ที่ container ผู้ใช้เข้าไม่ถึง
- ทุก API ตรวจ role + การเป็นสมาชิก project ฝั่ง server
- รหัสผ่านใช้ hash ที่ออกแบบมาสำหรับรหัสผ่าน (argon2/bcrypt), session cookie แบบ `HttpOnly` + `Secure` + host-only ผูกกับโดเมน panel และชื่อขึ้นต้น `__Host-` (กันแอปบน subdomain ข้างเคียงตั้ง cookie ทับ) ทุก mutation ตรวจ `Origin` ตรงกับ origin ของ panel
- firewall (เช่น `ufw`) เปิดแค่ 22, 80, 443 และช่วง port ของ public TCP
- **ความเสี่ยงที่ยอมรับ:** โค้ดของทีมรันระหว่าง build (เช่น `npm install` scripts) และ container ไม่ใช่กำแพงที่แข็งพอสำหรับคนที่ไม่ไว้ใจ ยอมรับได้เพราะผู้ใช้เป็นทีมภายใน ถ้าวันหนึ่งจะเปิดให้คนนอก ต้องทบทวนส่วนนี้ใหม่ทั้งหมด

## 6. หน้าจอ

- **Project canvas (ตัดสินใจแล้ว — แบบ A "Canvas แบบ Railway"):** การ์ด service วางบนพื้นที่ว่าง ลากย้ายได้และจำตำแหน่ง แต่ละการ์ดแสดงชื่อ, ชนิด (แอป/Postgres/Redis), สถานะ deploy ล่าสุดแบบสด, URL หรือขนาด volume มีเส้นโยงตามการอ้างตัวแปร ปุ่ม "+ เพิ่ม service" (GitHub repo / Postgres / Redis) แถบบนแสดงชื่อ project + environment
- **แผงข้างขวา (คลิกการ์ด):** แท็บ Deployments (ประวัติ + ปุ่ม rollback/redeploy/restart + log ของแต่ละ deploy), Variables, Logs (runtime สด), Settings (source, build, deploy, โดเมน, limit, public TCP, backup สำหรับ database, ลบ service)
- **หน้าอื่น:** ล็อกอิน, รายการ project, สมาชิก project, Admin (users, ตั้งค่าระบบ: โดเมน, GitHub App, limit เริ่มต้น, สถานะ backup ภายนอก)
- **ไลบรารี canvas (ผู้ออกแบบเลือก):** React Flow (`@xyflow/react`)

## 7. ส่วนที่ปล่อยให้ผู้สร้างตัดสินใจ

- ORM/query builder, ไลบรารี auth, UI component kit, ไลบรารีคิวงาน (ใช้ Postgres เป็นที่เก็บคิว)
- schema ฐานข้อมูลละเอียด (ตามโมเดลในข้อ 5.2)
- Traefik HTTP provider หรือ file provider (ข้อ 5.4)
- ที่เก็บ build/runtime log (ข้อ 5.6)
- ค่า default: memory limit ต่อ service (แนะนำ 512 MB), build timeout, drain time, จำนวน image ย้อนหลัง
- โครง monorepo (pnpm workspaces หรือเทียบเท่า) และวิธีทดสอบ
- วิธีติดตั้ง Railpack ใน worker และการ pin เวอร์ชันของ railpack CLI ให้ตรงกับ frontend image
- ลำดับการลงมือทำภายใน v1 แนะนำ: (1) worker build+run จาก repo ด้วยมือ (2) Traefik route + HTTPS (3) web + auth + project/service CRUD (4) GitHub webhook (5) ตัวแปร + database template + backup (6) Canvas + log สด
