# คู่มือติดตั้งและดูแลระบบ

คู่มือนี้ใช้กับแผน 1 (deploy engine) และแผน 2 (web dashboard): ระบบรันบน VPS เครื่องเดียวด้วย `docker compose` สั่งงานผ่านหน้าเว็บ (หัวข้อ "Dashboard") หรือผ่าน CLI ของ worker

## ภาพรวม

| Service | Image | หน้าที่ |
| --- | --- | --- |
| `postgres` | `postgres:18` | ฐานข้อมูลของระบบ และใช้ตาราง `deployments` เป็นคิวงาน (ไม่เปิด port ออกนอก network `vpsm-control`) |
| `traefik` | `traefik:v3.7` | รับ HTTP/HTTPS (port 80 และ 443) ออกใบรับรอง Let's Encrypt และส่งต่อไปยังแอป โดยอ่าน route จากไฟล์ที่ worker เขียน (ปิด API และ dashboard ของ Traefik เอง) |
| `worker` | build จาก `apps/worker/Dockerfile` | เดียวที่ถือ Docker socket: ดึงโค้ดจาก GitHub, build ด้วย Railpack, รัน container, healthcheck, สลับ route แบบไม่ล่ม และรับคำสั่งจาก CLI รัน migration ของฐานข้อมูลตอนเริ่ม และเป็น `healthy` เมื่อ migrate กับกู้งานค้างเสร็จแล้ว |
| `web` | build จาก `apps/web/Dockerfile` | หน้าเว็บจัดการ (Next.js) ที่ `https://<PANEL_DOMAIN>` ไม่ถือ Docker socket ไม่เปิด port เข้าได้ทาง Traefik เท่านั้น (worker เขียน route ให้) และเริ่มหลังจาก worker `healthy` เท่านั้น |

ข้อมูลเก็บใน named volume: `vpsm-pgdata` (ฐานข้อมูล), `vpsm-acme` (ใบรับรอง), `vpsm-traefik-dynamic` (route ของ Traefik), `vpsm-work` (โค้ดที่กำลัง build ชั่วคราว) และ network `vpsm-control` (postgres + worker + web), `vpsm-edge` (Traefik + web)

## ข้อควรระวังด้านความปลอดภัย

- **worker มีสิทธิ์เทียบเท่า root บนเครื่อง VPS** เพราะถือ Docker socket (`/var/run/docker.sock`) ใครสั่งงาน worker ได้ก็ควบคุมทั้งเครื่องได้ และ worker รันเป็น root ใน container ของตัวเอง
- **worker ต้องไม่เปิด port ใดๆ เด็ดขาด** ห้ามเพิ่ม `ports:` ให้ service `worker` ใน `docker-compose.yml` และห้าม mount Docker socket ให้ service อื่นหรือ container ของผู้ใช้
- **`web` ต้องไม่เปิด port และไม่มี Docker socket และไม่ได้รับ `.env` ทั้งไฟล์** `docker-compose.yml` ส่งให้เฉพาะตัวแปรที่ panel อ่านจริง (`DATABASE_URL`, `APPS_DOMAIN`, `PANEL_DOMAIN`, `PUBLIC_HTTPS_PORT`, `MEMORY_BUDGET_MB`, `MAX_SERVICE_MEMORY_MB`) `GITHUB_TOKEN` และ `ACME_EMAIL` จึงไม่เข้า container ของ panel (รหัสผ่านฐานข้อมูลอยู่ใน `DATABASE_URL` เพราะ panel ต้องใช้) ถ้าเพิ่มค่าตั้งที่ panel ต้องอ่าน ให้เพิ่มใน `environment:` ของ service `web` เอง panel รันเป็นผู้ใช้ `node` (ไม่ใช่ root) โดยตัด Linux capability ทิ้งทั้งหมด (`cap_drop: [ALL]`) และเพิ่มสิทธิ์ให้ตัวเองไม่ได้ (`no-new-privileges:true`) ห้ามเอาสองข้อนี้ออก เข้าได้ทาง Traefik เท่านั้น (ดูหัวข้อ "Dashboard" เรื่อง panel ที่เป็น same-site กับแอปของทีม) และห้ามเพิ่ม `forwardedHeaders.insecure` หรือ `forwardedHeaders.trustedIPs` ให้ Traefik เพราะตัวจำกัดการล็อกอินของ panel เชื่อ `X-Forwarded-For` รายการแรกที่ Traefik ตั้งให้
- สั่งงานระบบได้สองทาง: ผ่านหน้าเว็บ (panel ต้องล็อกอิน และ `member` เห็นเฉพาะ project ที่เป็นสมาชิก) และผ่าน CLI ของ worker ด้วย `sudo docker compose exec worker …` ซึ่งเป็นทางของผู้ดูแลระบบ CLI ไม่ถามรหัสผ่านและไม่ตรวจสิทธิ์ใดๆ ดังนั้นคนที่ใช้ `docker` บน VPS ได้ (กลุ่ม `docker` หรือ root) คือผู้ดูแลระบบทั้งหมด และมีสิทธิ์เทียบเท่า root บนเครื่อง ไม่ว่าจะมีบัญชีใน panel หรือไม่
- คำสั่ง `docker` ทุกคำสั่งในคู่มือนี้ (หลังรันสคริปต์ติดตั้ง) ขึ้นต้นด้วย `sudo` เพราะสคริปต์ไม่ได้เพิ่มผู้ใช้เข้ากลุ่ม `docker` และไม่แนะนำให้เพิ่ม: สมาชิกกลุ่ม `docker` ได้สิทธิ์เทียบเท่า root โดยไม่ต้องใส่รหัสผ่าน การใช้ `sudo` ทำให้ทุกคำสั่งต้องยืนยันตัวตนและถูกบันทึกไว้
- ไฟล์ `.env` เก็บรหัสผ่านฐานข้อมูลและ `GITHUB_TOKEN` ห้าม commit (อยู่ใน `.gitignore` แล้ว) และควรสั่ง `chmod 600 .env`
- `GITHUB_TOKEN` ให้ใช้ fine-grained token ที่อ่านอย่างเดียว (Contents: Read-only) และเลือกเฉพาะ repo ที่จะ deploy
- Traefik ไม่ได้เปิด API/dashboard ของตัวเอง หน้าเว็บบริหารมีหน้าเดียวคือ panel ของระบบนี้ (หัวข้อ "Dashboard") ซึ่งต้องล็อกอินก่อนใช้งานทุกหน้า
- port ที่ Docker เปิด (`ports:`) ผ่านกฎ iptables ของ Docker และ **ไม่ถูก ufw กรอง** ในแผนนี้ compose เปิดแค่ 80 และ 443 จึงปลอดภัย แต่ถ้าเพิ่ม `ports:` ให้ service ใดต้องรู้ข้อนี้ไว้

## สิ่งที่ต้องมี

- VPS Ubuntu 4 vCPU, RAM 8 GB, เข้าถึงด้วย SSH และมีสิทธิ์ `sudo`
- โดเมนที่ตั้ง DNS ได้ (ในตัวอย่างใช้ `apps.example.com` ให้แทนด้วยโดเมนจริง)
- port 80 และ 443 เข้าถึงได้จากอินเทอร์เน็ต (Let's Encrypt ใช้ HTTP challenge ผ่าน port 80) ถ้าสอง port นี้ถูกโปรแกรมอื่นใช้อยู่ ให้ดูหัวข้อ "เมื่อ port 80/443 ถูกใช้อยู่แล้ว" ท้ายคู่มือ
- โค้ดของโปรเจกต์นี้อยู่บน GitHub (repo `xkiixr/vps-management`) และ push ขึ้นไปแล้ว เพราะ worker ดึงแอปตัวอย่างจาก GitHub

## หน่วยความจำและ swap (อ่านก่อนติดตั้ง)

ด้วยค่าเริ่มต้น **เพดาน memory ของทุกส่วนรวมกันเกิน 8 GB** ของเครื่อง:

| ส่วน | เพดาน memory |
| --- | --- |
| แอปของผู้ใช้รวมกัน (`MEMORY_BUDGET_MB`) | 5632 MB |
| builder `vpsm-builder` (ใช้เฉพาะตอน build) | 3072 MB |
| control plane: postgres 512 + traefik 256 + worker 768 + web 512 | 2048 MB |
| **รวม** | **10752 MB (ประมาณ 10.5 GB)** |

ตั้งใจให้เป็นแบบนี้ (แอปส่วนใหญ่ใช้ไม่เต็มเพดาน และ build เกิดเป็นครั้งคราว) แต่ถ้าทุกส่วนใช้ memory พร้อมกันจนเครื่องหมด kernel จะ kill process (OOM killer) และ **ออกแบบให้ kill แอปของผู้ใช้และงาน build ก่อนเสมอ**: container ของแอปตั้ง `oom_score_adj` เป็น 500 ส่วน postgres, traefik, worker และ web ตั้ง -900 พร้อม `mem_reservation` (ใน `docker-compose.yml`) ฐานข้อมูล, Traefik, worker และ web จึงรอด แต่แอปบางตัวอาจถูก kill (Docker restart ให้ตาม restart policy) หรือ build อาจล้มเหลว

ควรทำอย่างใดอย่างหนึ่งก่อนใช้งานจริง:

- **เพิ่ม swap 2–4 GB** (แนะนำ) เพื่อรับช่วงที่ memory พุ่งขึ้นชั่วคราว ตัวอย่าง 4 GB:
  ```bash
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
  swapon --show
  ```
  container ของแอปไม่ใช้ swap (ตั้ง memory swap เท่ากับ memory) แต่ส่วนอื่นของเครื่องใช้ได้ kernel จึงไม่ต้อง kill เร็วเกินไป
- **หรือลด `MEMORY_BUDGET_MB`** ใน `.env` เช่น `3072` (รวมเป็น 3072 + 3072 + 2048 = 8192 MB) แลกกับการรันแอปได้น้อยลง

## 1. ตั้งค่า DNS

สร้าง wildcard record ที่ชี้มายัง IP ของ VPS:

```text
*.apps.example.com   A   <IP ของ VPS>
```

แอปแต่ละตัวจะได้ URL `https://<service>-<project>.apps.example.com` เช่น service `hello` ใน project `demo` ได้ `https://hello-demo.apps.example.com` Traefik ขอใบรับรอง Let's Encrypt ให้ทีละชื่อโดยอัตโนมัติ **ทันทีที่ route โหลดเข้า Traefik ซึ่งคือหลัง deployment ขึ้น live** (ไม่ได้รอให้มีคนเข้าเว็บ) ดังนั้น **ต้องตั้ง DNS `*.apps.example.com` ให้ชี้มาที่ VPS และ port 80 เข้าถึงได้ก่อน deploy ครั้งแรก** ไม่เช่นนั้นการขอใบรับรองจะล้มเหลวและเว็บจะขึ้นใบรับรองที่ไม่ถูกต้อง Let's Encrypt มีเพดานการออกใบรับรองต่อสัปดาห์ จึงไม่ควรสร้าง/ลบ service ถี่ๆ เพื่อทดลอง

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

> **ระวังก่อนรันสคริปต์:** `ufw allow OpenSSH` เปิดเฉพาะ port 22 ถ้า sshd บนเครื่องใช้ port อื่น ให้เปิด port จริงก่อน (เช่น `sudo ufw allow 2222/tcp`) แล้วค่อยรันสคริปต์ ไม่เช่นนั้นเมื่อ `ufw --force enable` ทำงานคุณจะเข้า SSH ไม่ได้อีก

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
| `PANEL_DOMAIN` | ชื่อโดเมนของหน้าเว็บจัดการ เช่น `panel.apps.example.com` (ใต้ `APPS_DOMAIN` ระดับเดียว) **ต้องตั้ง** ดูหัวข้อ "Dashboard" |
| `MEMORY_BUDGET_MB` | งบ RAM รวมของแอปผู้ใช้ ค่าเริ่มต้น 5632 MB (ตั้งไว้ตั้งแต่ก่อนมี `web` โดยเหลือ 2560 MB ไว้ให้ control plane และระบบ) ตอนนี้เพดานของ control plane รวม 2048 MB (postgres 512 + traefik 256 + worker 768 + web 512) 5632 + 2048 = 7680 MB จึงเหลือให้ระบบปฏิบัติการและ cache เพียงราว 512 MB ถ้าทุกส่วนใช้เต็มเพดาน และเมื่อรวม builder อีก 3072 MB เพดานรวมเกิน 8 GB ตามที่ตั้งใจและอธิบายไว้ในหัวข้อ "หน่วยความจำและ swap" (ควรมี swap หรือลดค่านี้) เกินงบแล้วปฏิเสธการ deploy ทันที |
| `MAX_SERVICE_MEMORY_MB` | memory สูงสุดต่อ service (ค่าเริ่มต้น 2048) |
| `GITHUB_TOKEN` | fine-grained token อ่านอย่างเดียว ใช้ clone repo (เว้นว่างได้ถ้า repo เป็น public) ใช้จนกว่าจะมี GitHub App ในแผน 3 |

ถ้าไม่ตั้ง `POSTGRES_PASSWORD`, `ACME_EMAIL` หรือ `PANEL_DOMAIN` คำสั่ง `docker compose` จะหยุดพร้อมข้อความบอกตัวแปรที่ขาด

## 4. เริ่มระบบ

```bash
sudo docker compose build worker && sudo docker compose build web   # ทีละ image (อ่านเหตุผลด้านล่าง)
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs worker
```

**บน VPS 8 GB ให้ build image ทีละตัวก่อน `up -d` อย่างข้างบน** เพราะ `docker compose up -d --build` (และ `docker compose build` เฉยๆ) build หลาย image พร้อมกัน ส่วน `next build` ของ `web` ใช้ RAM มากอยู่แล้ว (ยังไม่ได้วัดบน VPS จริง) ถ้ามาซ้อนกับการ build ของ worker และแอปที่รันอยู่ kernel อาจ kill process (ดูหัวข้อ "หน่วยความจำและ swap") `up -d` ที่ไม่มี `--build` ใช้ image ที่ build ไว้แล้ว

ผลที่ถูกต้อง: `postgres` เป็น `healthy`, `traefik` เป็น `running`, `worker` เป็น `healthy` (หลัง migrate และกู้งานค้างเสร็จ) และ `web` เป็น `healthy`; log ของ worker มี `buildx: vpsm-builder`, `recovery: 0 interrupted deployment(s) …` และ `worker started` โดยไม่มีบรรทัด error (การ migrate ฐานข้อมูลทำเองตอน worker เริ่ม) `web` จะไม่เริ่มจนกว่า `worker` จะ `healthy` การ build image ของ `web` ครั้งแรกใช้เวลาหลายนาที จึงควรทำตอนไม่มี deployment กำลัง build

worker ลงทะเบียน builder `vpsm-builder` (จำกัด memory 3 GB และ CPU 3 core) **ตอนเริ่มทำงาน** ไม่ใช่ตอน build ครั้งแรก บรรทัด `buildx: vpsm-builder` คือผลของการลงทะเบียนนี้ และจะปรากฏอีกทุกครั้งที่ container ของ worker ถูกสร้างใหม่ (ตรวจได้ด้วย `sudo docker compose exec worker docker buildx ls`) ส่วน container ของ BuildKit จะเริ่มจริงตอน build ครั้งแรก

## 5. คำสั่ง CLI

รันผ่าน container ของ worker ทั้งหมด:

```bash
sudo docker compose exec worker node dist/cli.js <คำสั่ง>
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
| `user:create <email> --name <name> [--admin]` | สร้างบัญชีผู้ใช้ของเว็บ (ค่าเริ่มต้นเป็น member, `--admin` สำหรับ admin) พิมพ์รหัสผ่านที่สร้างให้ **ครั้งเดียว** แล้วไม่แสดงอีก |
| `user:reset-password <email>` | ตั้งรหัสผ่านใหม่ พิมพ์รหัสใหม่ครั้งเดียว และออกจากระบบทุก session ของผู้ใช้นั้น |
| `user:list` | แสดงผู้ใช้ทั้งหมด: อีเมล บทบาท และ `active`/`disabled` |

ทุกคำสั่งที่แก้ข้อมูลบันทึก audit event (ผู้กระทำเป็นว่าง, `via: cli`) ถ้าบันทึกไม่สำเร็จ คำสั่งยังถือว่าสำเร็จและมีคำเตือนขึ้นที่ stderr

สถานะ deployment มีแค่ `QUEUED`, `BUILDING`, `DEPLOYING`, `SUCCESS`, `FAILED`, `CRASHED`, `REMOVED`, `SKIPPED` ระบบ build ทีละงานเท่านั้น งานที่เข้าคิวซ้อนกันของ service เดียวกันจะรอ และตัวที่ถูกแทนที่จะเป็น `SKIPPED`

## 6. ลอง deploy แอปตัวอย่าง

แอปตัวอย่างอยู่ที่ `examples/hello-node` (ตอบ `hello from vpsm` ที่ `/` และ `ok` ที่ `/health`):

```bash
sudo docker compose exec worker node dist/cli.js project:create demo
sudo docker compose exec worker node dist/cli.js service:create demo hello \
  --repo xkiixr/vps-management --branch master --root examples/hello-node --healthcheck /health
sudo docker compose exec worker node dist/cli.js status demo
curl -s https://hello-demo.apps.example.com/
```

ภายในประมาณ 5 นาที `status` ต้องแสดง `hello  SUCCESS  https://hello-demo.apps.example.com` และ `curl` ได้ `hello from vpsm` ผ่าน HTTPS ที่ใบรับรองถูกต้อง (branch `master` ต้องมีโฟลเดอร์ `examples/hello-node` อยู่บน GitHub แล้ว)

ถ้าใช้โหมด port อื่น (หัวข้อท้ายคู่มือ) ให้ใส่ `:8443` ท้ายทุก URL ในคำสั่ง `curl` ด้านบนและในผลลัพธ์ที่คาดไว้

## 7. อัปเดตระบบ

```bash
cd vps-management
git pull
sudo docker compose build worker && sudo docker compose build web
sudo docker compose up -d
```

บน VPS 8 GB ให้ build ทีละ image อย่างข้างบน (เหตุผลอยู่ในหัวข้อ 4) ถ้าเครื่องมี RAM เหลือเฟือจะใช้ `git pull && sudo docker compose up -d --build` ทีเดียวก็ได้

- แอปของผู้ใช้เป็น container แยก จึงยังรันต่อระหว่างอัปเดต
- ถ้า `sudo docker compose up -d` สร้าง Traefik ใหม่ (เช่น เปลี่ยน image หรือ config) container ใหม่จะหลุดจาก network ของแอปทุกตัว worker จะต่อ Traefik กลับเข้า network ของแอปที่ live อยู่ให้เองภายในประมาณ 60 วินาที (และตอน worker เริ่มทำงาน) ช่วงนั้นเว็บอาจตอบ 502 หรือ 404 สั้นๆ ไม่ต้อง deploy ใหม่
- ถ้าอัปเดตขณะมี deployment กำลัง build อยู่ worker จะถูกสร้างใหม่: worker เก่ารอให้ deployment นั้นทำเสร็จได้นานสุด 50 วินาที ถ้ายังไม่เสร็จ deployment นั้นจะถูกตั้งเป็น `FAILED` (`worker restarted during deployment`) ให้สั่ง `deploy <project> <service>` ใหม่หลัง worker กลับมา ควรอัปเดตตอนไม่มีงานค้าง (ดูด้วย `status <project>`)
- `sudo docker compose down` ไม่ลบข้อมูล แต่ **`docker compose down -v` ลบ volume ทั้งหมดรวมฐานข้อมูลและใบรับรอง** ห้ามใช้บน VPS จริง

## 8. สำรองฐานข้อมูล

```bash
sudo docker compose exec -T postgres pg_dump -U postgres postgres > vpsm-backup.sql
```

ไฟล์สำรองอยู่บนเครื่องเดียวกัน ควรคัดลอกออกไปเก็บนอกเครื่องด้วย (การสำรอง/กู้คืนอัตโนมัติและ offsite อยู่ในแผน 4)

## 9. แก้ปัญหา

| อาการ | วิธีตรวจ |
| --- | --- |
| `docker compose` ฟ้องตัวแปรขาด | ตรวจ `.env` ว่าตั้ง `POSTGRES_PASSWORD`, `ACME_EMAIL` และ `PANEL_DOMAIN` แล้ว |
| worker ปิดตัวแล้วเริ่มใหม่วนซ้ำ | `sudo docker compose logs worker` บรรทัด `worker: …` บอกสาเหตุ มักเป็น `APPS_DOMAIN` ไม่ถูกต้อง หรือเชื่อมฐานข้อมูลไม่ได้ |
| deployment เป็น `FAILED` | `logs <deploymentId>` (id อยู่ในบรรทัด `queued deployment <id>`); เหตุผลของ deployment ที่ถูกขัดจังหวะดูได้จาก `sudo docker compose exec postgres psql -U postgres -c "select status, failure_reason from deployments order by created_at desc limit 5"` |
| HTTPS ได้ใบรับรองผิด/ขึ้นเตือน | `sudo docker compose logs traefik` ตรวจ DNS ว่าชี้ถูก และ port 80 เข้าถึงได้จากภายนอก (โหมด port อื่นตามหัวข้อท้ายคู่มือไม่ใช้ port 80: ให้เปิด URL ที่มี `:8443`, ตรวจ `.duckdns.env` และดู log ของ traefik แทน) |
| แอปถูก restart เอง / build ล้มเหลวเพราะ memory หมด | `sudo dmesg \| grep -i 'killed process'` ถ้ามีบรรทัดของแอปหรือ BuildKit แปลว่าเครื่อง memory ไม่พอ (ดูหัวข้อ "หน่วยความจำและ swap") |
| panel (`https://panel.<APPS_DOMAIN>`) ขึ้น `404` หรือ `502` | `404` แปลว่า Traefik ไม่มี route ของชื่อนี้: ตรวจว่า `PANEL_DOMAIN` ใน `.env` ตรงกับชื่อที่เปิด (โหมด port อื่นต้องมี `:8443`) และ `sudo docker compose logs worker` ไม่มีบรรทัดเกี่ยวกับ route `panel` ที่ไม่ผ่านการตรวจ (เช่น ชื่อไม่ถูกต้อง) `502` แปลว่ามี route แต่ติดต่อ `web` ไม่ได้: `sudo docker compose ps web` ต้องเป็น `running (healthy)` และดู `sudo docker compose logs web` |
| panel เปิดได้แต่ล็อกอินหรือกดปุ่มแล้วขึ้น error `cross-origin request refused` | ต้องเปิดที่ `https://<PANEL_DOMAIN>` (บวก `:8443` ในโหมด port อื่น) ตรงตัวอักษร ไม่ใช่ผ่าน IP หรือชื่ออื่น เพราะทุก action ตรวจ header `Origin` กับชื่อนี้ |
| `docker compose up` รอ `worker` แล้วฟ้อง `unhealthy` ทำให้ `web` ไม่เริ่ม | worker ยังไม่ migrate/กู้งานค้างเสร็จ ดู `sudo docker compose logs worker` บรรทัด `worker: …` (มักเป็น `APPS_DOMAIN` หรือ `PANEL_DOMAIN` ไม่ถูกต้อง: ในโหมด port อื่น `PANEL_DOMAIN` ต้องเป็น `panel.<APPS_DOMAIN>` ระดับเดียว) แก้แล้วสั่ง `sudo docker compose up -d` ใหม่ |
| ลืมรหัสผ่านของ admin | `sudo docker compose exec worker node dist/cli.js user:reset-password <อีเมล>` (พิมพ์รหัสใหม่ครั้งเดียว) |
| ดู container ของแอปที่ระบบจัดการ | `sudo docker ps --filter label=vpsm.managed=true` |
| ดูเพดาน memory ของ builder | `sudo docker inspect buildx_buildkit_vpsm-builder0 --format '{{.HostConfig.Memory}}'` ต้องได้ `3221225472` (3 GB; container ของ BuildKit เริ่มตอน build ครั้งแรก จึงตรวจได้หลัง deploy ครั้งแรกเท่านั้น) |
| `docker compose up -d` ฟ้อง `port is already allocated` หรือ `address already in use` ที่ port 80/443 | Traefik ยังพยายามเปิด port 80/443 แปลว่าไฟล์ override `docker-compose.dns-tls.yml` ไม่ได้ถูกใช้ ตรวจว่า `COMPOSE_FILE=docker-compose.yml:docker-compose.dns-tls.yml` อยู่ใน `.env` โดยไม่มี `#` นำหน้า และ `docker compose version` ต้องเป็น 2.24.0 ขึ้นไป (ดูหัวข้อ "เมื่อ port 80/443 ถูกใช้อยู่แล้ว") |

## 10. รายการตรวจหลังติดตั้งบน VPS จริง

ทำตามลำดับ เพื่อยืนยันว่าระบบทำงานครบ (ต้องใช้ VPS, DNS และ GitHub จริง):

ถ้าใช้โหมด port อื่น (หัวข้อท้ายคู่มือ) ให้ใส่ `:8443` ท้ายทุก URL ที่ใช้ `curl` ในรายการนี้

1. **ติดตั้ง:** `sudo docker compose ps` แสดง postgres (healthy), traefik เป็น running, worker และ web เป็น healthy และ `sudo docker compose logs worker` ไม่มี error
2. **deploy แอปตัวอย่าง:** ทำตามหัวข้อ 6 แล้ว `status demo` ต้องเป็น `SUCCESS`, `curl` ต้องได้ `hello from vpsm` ผ่าน HTTPS และ memory ของ builder ต้องเป็น `3221225472`
3. **deploy แบบไม่ล่ม:** เปิด terminal ที่ 1 ยิงต่อเนื่อง
   ```bash
   while true; do curl -s -o /dev/null -w '%{http_code}\n' https://hello-demo.apps.example.com/; sleep 0.2; done
   ```
   แล้ว terminal ที่ 2 สั่ง `sudo docker compose exec worker node dist/cli.js deploy demo hello` ต้องได้ `200` ตลอด และ `status demo` แสดง `SUCCESS` ของ deployment ใหม่
4. **กู้งานค้าง:** สั่ง `deploy demo hello` แล้วระหว่าง build ให้ kill worker ทันทีและเปิดใหม่:
   ```bash
   sudo docker compose kill worker && sudo docker compose up -d worker
   ```
   deployment นั้นต้องเป็น `FAILED` (`worker restarted during deployment`), เว็บยังตอบ `200` และ `sudo docker ps --filter label=vpsm.managed=true` เหลือ container ของ hello เพียงตัวเดียว ขั้นนี้ต้องใช้ `kill` ไม่ใช่ `restart` หรือ `stop` เพราะสองคำสั่งนั้นส่ง SIGTERM และ worker จะรอให้ deployment ที่กำลังทำอยู่ทำเสร็จก่อนได้นานสุด 50 วินาที deploy สั้นๆ จึงจบเป็น `SUCCESS` ได้ตามปกติ ซึ่งไม่ได้แปลว่าการกู้งานค้างเสีย

## Dashboard

หน้าเว็บจัดการอยู่ที่ `https://panel.<APPS_DOMAIN>` (โหมด port อื่นคือ `https://panel.<APPS_DOMAIN>:8443`) ไม่มีหน้าสมัครสมาชิก: admin สร้างบัญชีให้ทีมจากหน้า Admin ของเว็บ ส่วนบัญชีแรกสร้างด้วย CLI (ด้านล่าง) ผู้ใช้มีสองบทบาท `admin` (จัดการผู้ใช้ ตั้งค่าระบบ เห็นทุก project) และ `member` (เห็นเฉพาะ project ที่เป็นสมาชิก)

### ตั้งค่า `PANEL_DOMAIN`

- ตั้ง `PANEL_DOMAIN` ใน `.env` เป็น `panel.<APPS_DOMAIN>` เช่น `panel.apps.example.com` สำหรับ VPS นี้คือ `panel.itexcellence.duckdns.org` (DNS แบบ wildcard `*.<APPS_DOMAIN>` ของหัวข้อ 1 ครอบคลุมชื่อนี้อยู่แล้ว)
- **ถ้าใช้โหมด port อื่น (ใบรับรอง wildcard) `PANEL_DOMAIN` ต้องเป็นชื่อระดับเดียวใต้ `APPS_DOMAIN` เท่านั้น** (`panel.<APPS_DOMAIN>`) เพราะใบรับรองครอบคลุมแค่ `*.<APPS_DOMAIN>` ชื่ออื่นจะได้ใบรับรองของชื่ออื่น worker จึงไม่ยอมเริ่มทำงานถ้าตั้งไม่ตรง และบอกในข้อความ error ว่า `PANEL_DOMAIN` ต้องเป็นชื่อระดับเดียวใต้ `APPS_DOMAIN`
- ชื่อนี้ถูกสงวนไว้ให้ panel แอปใดๆ ใช้ไม่ได้ ถ้าไม่ตั้ง `PANEL_DOMAIN` คำสั่ง `docker compose` จะหยุดพร้อมข้อความบอกตัวแปรที่ขาด

### เปิดใช้บนระบบที่ติดตั้งอยู่แล้ว (สลับครั้งแรก)

1. ตรวจว่า DNS ชี้มาที่ VPS: `dig +short panel.<APPS_DOMAIN>` ต้องได้ IP ของ VPS
2. เพิ่ม `PANEL_DOMAIN=panel.<APPS_DOMAIN>` ใน `.env` (สำหรับ VPS นี้ `PANEL_DOMAIN=panel.itexcellence.duckdns.org`)
3. ดึงโค้ดและ build ใหม่ (ต้อง build เสมอ เพราะต้องมี image ของ worker ที่รู้จัก panel และ image ของ `web`) บน VPS 8 GB ให้ build ทีละ image ก่อน `up -d` (เหตุผลอยู่ในหัวข้อ 4):

   ```bash
   cd vps-management
   git pull
   sudo docker compose build worker && sudo docker compose build web
   sudo docker compose up -d
   ```

   (ถ้าเครื่องมี RAM เหลือเฟือ `git pull && sudo docker compose up -d --build` ทีเดียวก็ได้) แอปของผู้ใช้เป็น container แยก จึงยังรันต่อระหว่างนี้ worker ถูกสร้างใหม่ (หัวข้อ 7 อธิบายกรณีมี deployment ค้าง)
4. รอจน worker เป็น `healthy` แล้ว `web` ก็เริ่มและเป็น `healthy`:

   ```bash
   sudo docker compose ps
   sudo docker compose logs worker
   ```

   worker เขียน route ของ panel ให้ Traefik ตอนเริ่มทำงาน
5. สร้าง admin คนแรก รหัสผ่านที่สร้างให้ **แสดงครั้งเดียว** คัดลอกเก็บไว้ทันที:

   ```bash
   sudo docker compose exec worker node dist/cli.js user:create you@example.com --name "Your Name" --admin
   ```

6. เปิด `https://panel.<APPS_DOMAIN>` (โหมด port อื่น `https://panel.<APPS_DOMAIN>:8443`) ล็อกอินด้วยอีเมลกับรหัสผ่านข้างต้น แล้ว **เปลี่ยนรหัสผ่านที่หน้า Account ทันที**
7. ให้ทีมเห็น project เดิม: project ที่สร้างด้วย CLI ของแผน 1 (`project:create`) **ไม่มีสมาชิกเลย** จึงมีแค่ admin ที่เห็น สร้างบัญชีให้ทีมที่เมนู Admin ก่อน แล้วในฐานะ admin เปิดแต่ละ project → **Members** → ใส่อีเมลของคนในทีม → **Add member** ทีละคน (`member` ที่ยังไม่ได้เพิ่มจะไม่เห็น project นั้นในหน้าเว็บ)

ใบรับรองของ panel ออกครั้งแรกที่ route ถูกโหลดเข้า Traefik (โหมดปกติขอทีละชื่อด้วย HTTP challenge โหมด port อื่นใช้ใบ wildcard ใบเดียวที่มีอยู่แล้ว) ช่วงแรก browser อาจเห็นใบรับรองเริ่มต้นของ Traefik ให้รอสักครู่แล้วเปิดใหม่ ผู้ใช้อื่นสร้างได้จากเมนู Admin ในเว็บ (รหัสผ่านที่สร้างให้แสดงครั้งเดียวเช่นกัน)

### ข้อควรระวัง: panel เป็น same-site กับแอปของทีม

`panel.<APPS_DOMAIN>` กับแอป `<service>-<project>.<APPS_DOMAIN>` อยู่ใต้โดเมนเดียวกัน browser จึงนับว่าเป็น **same-site** หน้าเว็บของแอปที่ deploy ไว้ส่งคำขอไปที่ panel ในนามผู้ใช้ที่ล็อกอินอยู่ได้ และ `SameSite` ของ cookie ช่วยไม่ได้ในกรณีนี้ ระบบจึงป้องกันไว้ดังนี้ (อย่าปิดหรือเลี่ยง):

- cookie ของ session ชื่อ `__Host-vpsm_session` เป็น `HttpOnly`, `Secure`, `Path=/` และไม่มี `Domain` แอปบน subdomain อื่นอ่านหรือเขียนทับไม่ได้
- ทุกการแก้ข้อมูล (server action) ตรวจ header `Origin` ให้ตรงกับ `https://<PANEL_DOMAIN>` แบบเป๊ะ ไม่ตรงหรือไม่มีจะปฏิเสธ
- ทุกหน้าของ panel ส่ง `X-Frame-Options: DENY` และ `Content-Security-Policy: frame-ancestors 'none'` (ตั้งใน `apps/web/next.config.ts`) แอปบน subdomain อื่นจึงฝัง panel ไว้ใน frame เพื่อหลอกให้ admin กดปุ่มไม่ได้ ถ้าไม่มีสอง header นี้ การกดใน frame จะผ่านการตรวจ `Origin` ข้างบนได้ เพราะคำขอมาจากหน้า panel เอง
- ล็อกอินผิดเกิน 10 ครั้งใน 15 นาทีจาก IP และอีเมลเดียวกันจะถูกปฏิเสธชั่วคราว (ตัวจำกัดนี้เชื่อ `X-Forwarded-For` รายการแรกที่ Traefik ตั้ง จึงห้ามตั้ง `forwardedHeaders` ให้ Traefik)

ถึงอย่างนั้นก็ควร deploy เฉพาะโค้ดของทีมที่เชื่อถือได้ เพราะโค้ดที่รันบน subdomain เดียวกันกับ panel เป็นด่านที่อ่อนที่สุดของระบบนี้

### คำสั่งที่ใช้บ่อย

```bash
sudo docker compose ps web                  # ต้องเป็น running (healthy)
sudo docker compose logs -f web             # log ของหน้าเว็บ
sudo docker compose exec worker node dist/cli.js user:list
sudo docker compose exec worker node dist/cli.js user:reset-password you@example.com
```

## เมื่อ port 80/443 ถูกใช้อยู่แล้ว (เช่น Nginx Proxy Manager)

ใช้หัวข้อนี้เมื่อบน VPS มีโปรแกรมอื่นใช้ port 80/443 อยู่ และต้องให้มันทำงานต่อ (เช่น Nginx Proxy Manager) Traefik จึงรับ HTTPS ที่ port อื่นแทน (ในตัวอย่างใช้ 8443) และไม่เปิด port 80 เลย port 80 ยังเป็นของ Nginx Proxy Manager ตามเดิม เพราะ Let's Encrypt แบบ HTTP challenge ต้องใช้ port 80 จึงเปลี่ยนไปขอใบรับรองด้วย DNS challenge ผ่าน DuckDNS แทน ระบบขอใบรับรอง **wildcard เพียงใบเดียว** (`*.<APPS_DOMAIN>`) ให้ทุกแอปใช้ร่วมกัน เพราะ DuckDNS เก็บ TXT record ได้ทีละค่าเดียว

ถ้า port 80/443 ว่างอยู่ ไม่ต้องทำหัวข้อนี้ ใช้ค่าเริ่มต้นตามหัวข้อ 1–4

### สิ่งที่ต้องมีเพิ่ม

- `APPS_DOMAIN` ต้องเป็นชื่อบน DuckDNS ที่ลงท้ายด้วย `.duckdns.org` เช่น `itexcellence.duckdns.org` (ถ้าไม่ใช่ worker จะไม่ยอมเริ่มทำงานในโหมดนี้) และต้องตั้ง IP ของชื่อนั้นบน DuckDNS เป็น IP ของ VPS ชื่อย่อยทุกชื่อ (`*.itexcellence.duckdns.org`) จะชี้มาที่ IP เดียวกัน
- DuckDNS token จากหน้า account ที่ duckdns.org (ต้องเป็นของบัญชีที่เป็นเจ้าของชื่อนั้น)
- **Docker Compose 2.24.0 ขึ้นไป** (ไฟล์ override ใช้ `!override`) ตรวจด้วย `docker compose version` ถ้าเก่ากว่านี้ให้อัปเกรดแพ็กเกจ `docker-compose-plugin` ก่อน

### สิ่งที่ต่างจากโหมดปกติ

- **ทุก URL แบบ `https://` ในคู่มือนี้ต้องใส่ `:8443` ท้ายชื่อโดเมน** รวมถึง panel (`https://panel.itexcellence.duckdns.org:8443`) คำสั่ง `curl` ในหัวข้อ 6 และรายการตรวจในหัวข้อ 10 เช่น `curl -s https://hello-demo.itexcellence.duckdns.org:8443/` (คำสั่ง `service:create`, `status` และ log ของ deployment พิมพ์ URL ที่มี `:8443` ให้เอง)
- Traefik ไม่มี HTTP entrypoint จึงเปิด `http://…:8443` ไม่ได้ (ได้ `400`) และไม่มีการ redirect จาก port 80 มาที่ HTTPS
- ใบรับรอง wildcard ครอบคลุมเฉพาะชื่อ `*.<APPS_DOMAIN>` ที่ระบบสร้างให้แอป และ `panel.<APPS_DOMAIN>` ของ panel (`PANEL_DOMAIN` ต้องเป็นชื่อระดับเดียวใต้ `APPS_DOMAIN` ตามหัวข้อ "Dashboard") โดเมนอื่นที่เพิ่มเองยังไม่รองรับในโหมดนี้
- ไม่ว่าจะมีกี่แอปก็ขอใบรับรองแค่ใบเดียว จึงไม่ติดเพดานการออกใบรับรองของ Let's Encrypt ที่เกิดจากการขอทีละชื่อแบบโหมดปกติ

### ขั้นตอนบน VPS

1. ดึงโค้ดล่าสุด (เพื่อให้มีไฟล์ `docker-compose.dns-tls.yml`) แล้วสร้างไฟล์ `.duckdns.env` เก็บ token ไว้ให้ Traefik อ่านเท่านั้น:

   ```bash
   cd vps-management
   git pull
   touch .duckdns.env && chmod 600 .duckdns.env
   nano .duckdns.env
   ```

   ในไฟล์มีบรรทัดเดียว (ไม่ต้องใส่เครื่องหมายคำพูด):

   ```bash
   DUCKDNS_TOKEN=<token จากหน้า account ของ duckdns.org>
   ```

   ไฟล์นี้อยู่ใน `.gitignore` และ `.dockerignore` แล้ว worker ไม่ได้รับ token นี้ **ห้ามแปะผลของ `docker compose config` หรือ log ของ `traefik` ในที่สาธารณะ** เพราะอาจมี token ปนอยู่

2. เพิ่มบรรทัดนี้ใน `.env` (ท้ายไฟล์ `.env.example` มีตัวอย่างที่ปิดด้วย `#` อยู่):

   ```bash
   COMPOSE_FILE=docker-compose.yml:docker-compose.dns-tls.yml
   ```

   Compose อ่าน `COMPOSE_FILE` จาก `.env` จึงใช้ `docker-compose.dns-tls.yml` ซ้อนบน `docker-compose.yml` ให้เองทุกครั้ง คำสั่ง `sudo docker compose …` ทั้งหมดในคู่มือนี้จึงใช้ต่อได้โดยไม่ต้องแก้ ไฟล์ override ตั้ง `TLS_MODE=dns-wildcard` และ `PUBLIC_HTTPS_PORT` ให้ worker เอง จึงไม่ต้องตั้งสองตัวนี้ใน `.env` (มีแต่ไฟล์ override เท่านั้นที่เปิดโหมดนี้ worker กับ Traefik จึงไม่ขัดกันเอง) ถ้าอยากใช้ port อื่นที่ไม่ใช่ 8443 ให้เพิ่ม `TRAEFIK_HTTPS_PORT=<port>`

3. เปิด port 8443 (TCP) ที่ firewall / security group ของผู้ให้บริการ VPS port ที่ Docker เปิดจะข้ามกฎของ ufw ดังนั้น `sudo ufw allow 8443/tcp` ไม่เป็นอันตรายแต่ไม่พอ และไม่ใช่สิ่งที่ตัดสินว่าเข้าถึงได้หรือไม่

4. สลับระบบ ต้อง build ใหม่เสมอ เพราะ `up -d` เฉยๆ ไม่ build worker ใหม่ worker เก่าจึงไม่รู้จักโหมดนี้ (บน VPS 8 GB ให้ build ทีละ image ตามหัวข้อ 4)
   - ติดตั้งใหม่ ยังไม่มีแอปที่ live:

     ```bash
     sudo docker compose build worker && sudo docker compose build web
     sudo docker compose up -d
     ```

   - มีแอปที่ live อยู่แล้ว ให้อัปเดต worker ก่อน เพื่อให้ไฟล์ route ถูกเขียนใหม่ในรูปแบบ wildcard ก่อนที่ Traefik ตัวใหม่จะอ่าน (ไม่เช่นนั้น Traefik จะอ่านไฟล์ route เก่าแล้วสั่งขอใบรับรองด้วย DNS challenge ทีละชื่อ):

     ```bash
     sudo docker compose build worker && sudo docker compose build web
     sudo docker compose up -d worker
     sudo docker compose logs worker      # รอจนเห็นบรรทัด worker started
     sudo docker compose up -d traefik
     sudo docker compose up -d            # สร้าง web ใหม่ด้วย PUBLIC_HTTPS_PORT ใหม่
     ```

     ตอน worker เริ่มทำงานจะเขียน route ของแอปที่ live อยู่ใหม่เอง ไม่ต้อง deploy ใหม่ ช่วงสลับเว็บอาจเข้าไม่ได้สั้นๆ

     คำสั่ง `sudo docker compose up -d` ตัวสุดท้าย **ห้ามข้าม**: ไฟล์ override เปลี่ยน `PUBLIC_HTTPS_PORT` ของ `web` จาก 443 เป็น 8443 `web` ที่รันอยู่จึงต้องถูกสร้างใหม่ ไม่เช่นนั้นมันจะยังเทียบ header `Origin` กับ `https://<PANEL_DOMAIN>` ที่ไม่มี `:8443` และทุกการล็อกอิน/กดปุ่มใน panel จะถูกปฏิเสธด้วย `cross-origin request refused`

5. ตรวจผล:

   ```bash
   sudo docker compose ps
   sudo docker compose logs traefik
   ```

   `docker compose ps` ต้องแสดง `vpsm-traefik` เป็น `running` และ port เป็น `0.0.0.0:8443->443/tcp` (ไม่มี port 80 หรือ 443)

   ใบรับรอง wildcard ถูกสั่งขอตอนที่ route ของแอปแรกถูกโหลดเข้า Traefik ไม่ใช่ตอน Traefik เริ่มทำงาน ดังนั้นบรรทัด `==> Live at https://…:8443` ใน log ของ deployment อาจขึ้นก่อนที่ใบรับรองจะออก การขอด้วย DNS challenge อาจใช้เวลาประมาณ 1–2 นาที (ยังไม่ได้ยืนยันบน VPS จริง) ระหว่างนั้น browser จะเห็นใบรับรองเริ่มต้นของ Traefik ซึ่งไม่น่าเชื่อถือ ให้รอแล้วลองเปิดใหม่ ถ้านานกว่านั้นให้ดู `sudo docker compose logs traefik` หาบรรทัด error ที่เกี่ยวกับ `acme` หรือ `duckdns` และตรวจว่า token ถูกต้องและ `APPS_DOMAIN` เป็นชื่อที่ token นั้นเป็นเจ้าของ

การอัปเดตครั้งต่อไปใช้ตามหัวข้อ 7 ได้ตามเดิม (`git pull`, build ทีละ image แล้ว `sudo docker compose up -d`)
