# คู่มือติดตั้งและดูแลระบบ

คู่มือนี้ใช้กับแผน 1 (deploy engine): ระบบรันบน VPS เครื่องเดียวด้วย `docker compose` และสั่งงานผ่าน CLI ของ worker (ยังไม่มี dashboard)

## ภาพรวม

| Service | Image | หน้าที่ |
| --- | --- | --- |
| `postgres` | `postgres:18` | ฐานข้อมูลของระบบ และใช้ตาราง `deployments` เป็นคิวงาน (ไม่เปิด port ออกนอก network `vpsm-control`) |
| `traefik` | `traefik:v3.7` | รับ HTTP/HTTPS (port 80 และ 443) ออกใบรับรอง Let's Encrypt และส่งต่อไปยังแอป โดยอ่าน route จากไฟล์ที่ worker เขียน (ปิด API และ dashboard) |
| `worker` | build จาก `apps/worker/Dockerfile` | เดียวที่ถือ Docker socket: ดึงโค้ดจาก GitHub, build ด้วย Railpack, รัน container, healthcheck, สลับ route แบบไม่ล่ม และรับคำสั่งจาก CLI |

ข้อมูลเก็บใน named volume: `vpsm-pgdata` (ฐานข้อมูล), `vpsm-acme` (ใบรับรอง), `vpsm-traefik-dynamic` (route ของ Traefik), `vpsm-work` (โค้ดที่กำลัง build ชั่วคราว) และ network `vpsm-control` (postgres + worker), `vpsm-edge` (Traefik)

## ข้อควรระวังด้านความปลอดภัย

- **worker มีสิทธิ์เทียบเท่า root บนเครื่อง VPS** เพราะถือ Docker socket (`/var/run/docker.sock`) ใครสั่งงาน worker ได้ก็ควบคุมทั้งเครื่องได้ และ worker รันเป็น root ใน container ของตัวเอง
- **worker ต้องไม่เปิด port ใดๆ เด็ดขาด** ห้ามเพิ่ม `ports:` ให้ service `worker` ใน `docker-compose.yml` และห้าม mount Docker socket ให้ service อื่นหรือ container ของผู้ใช้
- การควบคุมระบบในแผนนี้ทำผ่าน `docker compose exec worker …` เท่านั้น ดังนั้นคนที่ใช้ `docker` บน VPS ได้ (กลุ่ม `docker` หรือ root) คือผู้ดูแลระบบทั้งหมด
- ไฟล์ `.env` เก็บรหัสผ่านฐานข้อมูลและ `GITHUB_TOKEN` ห้าม commit (อยู่ใน `.gitignore` แล้ว) และควรสั่ง `chmod 600 .env`
- `GITHUB_TOKEN` ให้ใช้ fine-grained token ที่อ่านอย่างเดียว (Contents: Read-only) และเลือกเฉพาะ repo ที่จะ deploy
- Traefik ไม่ได้เปิด API/dashboard ดังนั้นไม่มีหน้าเว็บบริหารที่ต้องป้องกัน
- port ที่ Docker เปิด (`ports:`) ผ่านกฎ iptables ของ Docker และ **ไม่ถูก ufw กรอง** ในแผนนี้ compose เปิดแค่ 80 และ 443 จึงปลอดภัย แต่ถ้าเพิ่ม `ports:` ให้ service ใดต้องรู้ข้อนี้ไว้

## สิ่งที่ต้องมี

- VPS Ubuntu 4 vCPU, RAM 8 GB, เข้าถึงด้วย SSH และมีสิทธิ์ `sudo`
- โดเมนที่ตั้ง DNS ได้ (ในตัวอย่างใช้ `apps.example.com` ให้แทนด้วยโดเมนจริง)
- port 80 และ 443 เข้าถึงได้จากอินเทอร์เน็ต (Let's Encrypt ใช้ HTTP challenge ผ่าน port 80)
- โค้ดของโปรเจกต์นี้อยู่บน GitHub (repo `xkiixr/vps-management`) และ push ขึ้นไปแล้ว เพราะ worker ดึงแอปตัวอย่างจาก GitHub

## 1. ตั้งค่า DNS

สร้าง wildcard record ที่ชี้มายัง IP ของ VPS:

```text
*.apps.example.com   A   <IP ของ VPS>
```

แอปแต่ละตัวจะได้ URL `https://<service>-<project>.apps.example.com` เช่น service `hello` ใน project `demo` ได้ `https://hello-demo.apps.example.com` ใบรับรอง Let's Encrypt ออกให้ทีละชื่อโดยอัตโนมัติตอนมีคนเข้าครั้งแรก (ครั้งแรกอาจช้ากว่าปกติสักครู่) และมีเพดานการออกใบรับรองต่อสัปดาห์ของ Let's Encrypt จึงไม่ควรสร้าง/ลบ service ถี่ๆ เพื่อทดลอง

ตรวจว่า DNS ใช้ได้ก่อนติดตั้ง:

```bash
dig +short hello-demo.apps.example.com
```

## 2. ติดตั้งบน VPS

```bash
git clone https://github.com/xkiixr/vps-management.git
cd vps-management
sudo bash deploy/install-ubuntu.sh
```

สคริปต์ติดตั้ง Docker Engine (จาก `https://get.docker.com`) และตั้ง ufw ให้เปิดเฉพาะ SSH, 80/tcp และ 443/tcp (ช่วง port 30000–32767 จะเปิดในแผน 4) สคริปต์ต้องรันด้วย root, รันซ้ำได้ และไม่พิมพ์ค่า secret ใดๆ

## 3. ตั้งค่า `.env`

```bash
cp .env.example .env
chmod 600 .env
openssl rand -hex 24      # ใช้ค่าที่ได้เป็น POSTGRES_PASSWORD
nano .env
```

| ตัวแปร | ความหมาย |
| --- | --- |
| `POSTGRES_PASSWORD` | รหัสผ่านฐานข้อมูล **ต้องตั้ง** ใช้ตัวอักษร/ตัวเลขเท่านั้น (hex ได้) เพราะถูกใส่ใน `DATABASE_URL` |
| `DATABASE_URL` | ปล่อยตามตัวอย่าง (ใช้ `${POSTGRES_PASSWORD}`) |
| `APPS_DOMAIN` | โดเมนของแอป เช่น `apps.example.com` (ตัวพิมพ์เล็ก) |
| `ACME_EMAIL` | อีเมลสำหรับ Let's Encrypt **ต้องตั้ง** |
| `MEMORY_BUDGET_MB` | งบ RAM รวมของแอปผู้ใช้ (ค่าเริ่มต้น 5632 = 8192 − 2560) เกินงบแล้วปฏิเสธการ deploy ทันที |
| `MAX_SERVICE_MEMORY_MB` | memory สูงสุดต่อ service (ค่าเริ่มต้น 2048) |
| `GITHUB_TOKEN` | fine-grained token อ่านอย่างเดียว ใช้ clone repo (เว้นว่างได้ถ้า repo เป็น public) ใช้จนกว่าจะมี GitHub App ในแผน 3 |

ถ้าไม่ตั้ง `POSTGRES_PASSWORD` หรือ `ACME_EMAIL` คำสั่ง `docker compose` จะหยุดพร้อมข้อความบอกตัวแปรที่ขาด

## 4. เริ่มระบบ

```bash
docker compose up -d --build
docker compose ps
docker compose logs worker
```

ผลที่ถูกต้อง: `postgres` เป็น `healthy`, `traefik` และ `worker` เป็น `running`; log ของ worker มี `buildx: vpsm-builder`, `recovery: 0 interrupted deployment(s) …` และ `worker started` โดยไม่มีบรรทัด error (การ migrate ฐานข้อมูลทำเองตอน worker เริ่ม)

## 5. คำสั่ง CLI

รันผ่าน container ของ worker ทั้งหมด:

```bash
docker compose exec worker node dist/cli.js <คำสั่ง>
```

| คำสั่ง | ความหมาย |
| --- | --- |
| `project:create <project>` | สร้าง project |
| `service:create <project> <service> --repo <owner/name> --branch <branch> [--root <dir>] [--healthcheck <path>] [--port <n>] [--memory <mb>] [--start <cmd>]` | สร้าง service, พิมพ์ URL แล้วเข้าคิว deploy ครั้งแรก |
| `deploy <project> <service>` | deploy ใหม่จาก branch ล่าสุด |
| `rollback <project> <service> <deploymentId>` | กลับไปใช้ image ของ deployment เดิม |
| `restart <project> <service>` | restart container ที่ live อยู่ |
| `status <project>` | แสดงทุก service: ชื่อ สถานะของ deployment ล่าสุด และ URL |
| `logs <deploymentId>` | แสดง log ของ deployment (ทั้งตอน build และ deploy) |

สถานะ deployment มีแค่ `QUEUED`, `BUILDING`, `DEPLOYING`, `SUCCESS`, `FAILED`, `CRASHED`, `REMOVED`, `SKIPPED` ระบบ build ทีละงานเท่านั้น งานที่เข้าคิวซ้อนกันของ service เดียวกันจะรอ และตัวที่ถูกแทนที่จะเป็น `SKIPPED`

## 6. ลอง deploy แอปตัวอย่าง

แอปตัวอย่างอยู่ที่ `examples/hello-node` (ตอบ `hello from vpsm` ที่ `/` และ `ok` ที่ `/health`):

```bash
docker compose exec worker node dist/cli.js project:create demo
docker compose exec worker node dist/cli.js service:create demo hello \
  --repo xkiixr/vps-management --branch master --root examples/hello-node --healthcheck /health
docker compose exec worker node dist/cli.js status demo
curl -s https://hello-demo.apps.example.com/
```

ภายในประมาณ 5 นาที `status` ต้องแสดง `hello  SUCCESS  https://hello-demo.apps.example.com` และ `curl` ได้ `hello from vpsm` ผ่าน HTTPS ที่ใบรับรองถูกต้อง (branch `master` ต้องมีโฟลเดอร์ `examples/hello-node` อยู่บน GitHub แล้ว)

## 7. อัปเดตระบบ

```bash
cd vps-management
git pull && docker compose up -d --build
```

- แอปของผู้ใช้เป็น container แยก จึงยังรันต่อระหว่างอัปเดต
- ถ้าอัปเดตขณะมี deployment กำลัง build อยู่ worker จะถูกสร้างใหม่ และ deployment นั้นถูกตั้งเป็น `FAILED` (`worker restarted during deployment`) ให้สั่ง `deploy <project> <service>` ใหม่หลัง worker กลับมา ควรอัปเดตตอนไม่มีงานค้าง (ดูด้วย `status <project>`)
- `docker compose down` ไม่ลบข้อมูล แต่ **`docker compose down -v` ลบ volume ทั้งหมดรวมฐานข้อมูลและใบรับรอง** ห้ามใช้บน VPS จริง

## 8. สำรองฐานข้อมูล

```bash
docker compose exec -T postgres pg_dump -U postgres postgres > vpsm-backup.sql
```

ไฟล์สำรองอยู่บนเครื่องเดียวกัน ควรคัดลอกออกไปเก็บนอกเครื่องด้วย (การสำรอง/กู้คืนอัตโนมัติและ offsite อยู่ในแผน 4)

## 9. แก้ปัญหา

| อาการ | วิธีตรวจ |
| --- | --- |
| `docker compose` ฟ้องตัวแปรขาด | ตรวจ `.env` ว่าตั้ง `POSTGRES_PASSWORD` และ `ACME_EMAIL` แล้ว |
| worker ปิดตัวแล้วเริ่มใหม่วนซ้ำ | `docker compose logs worker` บรรทัด `worker: …` บอกสาเหตุ มักเป็น `APPS_DOMAIN` ไม่ถูกต้อง หรือเชื่อมฐานข้อมูลไม่ได้ |
| deployment เป็น `FAILED` | `logs <deploymentId>` (id อยู่ในบรรทัด `queued deployment <id>`); เหตุผลของ deployment ที่ถูกขัดจังหวะดูได้จาก `docker compose exec postgres psql -U postgres -c "select status, failure_reason from deployments order by created_at desc limit 5"` |
| HTTPS ได้ใบรับรองผิด/ขึ้นเตือน | `docker compose logs traefik` ตรวจ DNS ว่าชี้ถูก และ port 80 เข้าถึงได้จากภายนอก |
| ดู container ของแอปที่ระบบจัดการ | `docker ps --filter label=vpsm.managed=true` |
| ดูเพดาน memory ของ builder | `docker inspect buildx_buildkit_vpsm-builder0 --format '{{.HostConfig.Memory}}'` ต้องได้ `3221225472` (3 GB; builder ถูกสร้างตอน build ครั้งแรก) |

## 10. รายการตรวจหลังติดตั้งบน VPS จริง

ทำตามลำดับ เพื่อยืนยันว่าระบบทำงานครบ (ต้องใช้ VPS, DNS และ GitHub จริง):

1. **ติดตั้ง:** `docker compose ps` แสดง postgres (healthy), traefik, worker เป็น running และ `docker compose logs worker` ไม่มี error
2. **deploy แอปตัวอย่าง:** ทำตามหัวข้อ 6 แล้ว `status demo` ต้องเป็น `SUCCESS`, `curl` ต้องได้ `hello from vpsm` ผ่าน HTTPS และ memory ของ builder ต้องเป็น `3221225472`
3. **deploy แบบไม่ล่ม:** เปิด terminal ที่ 1 ยิงต่อเนื่อง
   ```bash
   while true; do curl -s -o /dev/null -w '%{http_code}\n' https://hello-demo.apps.example.com/; sleep 0.2; done
   ```
   แล้ว terminal ที่ 2 สั่ง `docker compose exec worker node dist/cli.js deploy demo hello` ต้องได้ `200` ตลอด และ `status demo` แสดง `SUCCESS` ของ deployment ใหม่
4. **กู้งานค้าง:** สั่ง `deploy demo hello` แล้ว `docker compose restart worker` ระหว่าง build deployment นั้นต้องเป็น `FAILED` (`worker restarted during deployment`), เว็บยังตอบ `200` และ `docker ps --filter label=vpsm.managed=true` เหลือ container ของ hello เพียงตัวเดียว
