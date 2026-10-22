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
- การควบคุมระบบในแผนนี้ทำผ่าน `sudo docker compose exec worker …` เท่านั้น ดังนั้นคนที่ใช้ `docker` บน VPS ได้ (กลุ่ม `docker` หรือ root) คือผู้ดูแลระบบทั้งหมด
- คำสั่ง `docker` ทุกคำสั่งในคู่มือนี้ (หลังรันสคริปต์ติดตั้ง) ขึ้นต้นด้วย `sudo` เพราะสคริปต์ไม่ได้เพิ่มผู้ใช้เข้ากลุ่ม `docker` และไม่แนะนำให้เพิ่ม: สมาชิกกลุ่ม `docker` ได้สิทธิ์เทียบเท่า root โดยไม่ต้องใส่รหัสผ่าน การใช้ `sudo` ทำให้ทุกคำสั่งต้องยืนยันตัวตนและถูกบันทึกไว้
- ไฟล์ `.env` เก็บรหัสผ่านฐานข้อมูลและ `GITHUB_TOKEN` ห้าม commit (อยู่ใน `.gitignore` แล้ว) และควรสั่ง `chmod 600 .env`
- `GITHUB_TOKEN` ให้ใช้ fine-grained token ที่อ่านอย่างเดียว (Contents: Read-only) และเลือกเฉพาะ repo ที่จะ deploy
- Traefik ไม่ได้เปิด API/dashboard ดังนั้นไม่มีหน้าเว็บบริหารที่ต้องป้องกัน
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
| control plane: postgres 512 + traefik 256 + worker 768 | 1536 MB |
| **รวม** | **10240 MB (ประมาณ 10 GB)** |

ตั้งใจให้เป็นแบบนี้ (แอปส่วนใหญ่ใช้ไม่เต็มเพดาน และ build เกิดเป็นครั้งคราว) แต่ถ้าทุกส่วนใช้ memory พร้อมกันจนเครื่องหมด kernel จะ kill process (OOM killer) และ **ออกแบบให้ kill แอปของผู้ใช้และงาน build ก่อนเสมอ**: container ของแอปตั้ง `oom_score_adj` เป็น 500 ส่วน postgres, traefik และ worker ตั้ง -900 พร้อม `mem_reservation` (ใน `docker-compose.yml`) ฐานข้อมูล, Traefik และ worker จึงรอด แต่แอปบางตัวอาจถูก kill (Docker restart ให้ตาม restart policy) หรือ build อาจล้มเหลว

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
- **หรือลด `MEMORY_BUDGET_MB`** ใน `.env` เช่น `3072` (รวมเป็น 3072 + 3072 + 1536 = 7680 MB) แลกกับการรันแอปได้น้อยลง

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
| `MEMORY_BUDGET_MB` | งบ RAM รวมของแอปผู้ใช้ (ค่าเริ่มต้น 5632 = 8192 − 2560) เกินงบแล้วปฏิเสธการ deploy ทันที (ดูหัวข้อ "หน่วยความจำและ swap") |
| `MAX_SERVICE_MEMORY_MB` | memory สูงสุดต่อ service (ค่าเริ่มต้น 2048) |
| `GITHUB_TOKEN` | fine-grained token อ่านอย่างเดียว ใช้ clone repo (เว้นว่างได้ถ้า repo เป็น public) ใช้จนกว่าจะมี GitHub App ในแผน 3 |

ถ้าไม่ตั้ง `POSTGRES_PASSWORD` หรือ `ACME_EMAIL` คำสั่ง `docker compose` จะหยุดพร้อมข้อความบอกตัวแปรที่ขาด

## 4. เริ่มระบบ

```bash
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs worker
```

ผลที่ถูกต้อง: `postgres` เป็น `healthy`, `traefik` และ `worker` เป็น `running`; log ของ worker มี `buildx: vpsm-builder`, `recovery: 0 interrupted deployment(s) …` และ `worker started` โดยไม่มีบรรทัด error (การ migrate ฐานข้อมูลทำเองตอน worker เริ่ม)

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

## 7. อัปเดตระบบ

```bash
cd vps-management
git pull && sudo docker compose up -d --build
```

- แอปของผู้ใช้เป็น container แยก จึงยังรันต่อระหว่างอัปเดต
- ถ้า `sudo docker compose up -d --build` สร้าง Traefik ใหม่ (เช่น เปลี่ยน image หรือ config) container ใหม่จะหลุดจาก network ของแอปทุกตัว worker จะต่อ Traefik กลับเข้า network ของแอปที่ live อยู่ให้เองภายในประมาณ 60 วินาที (และตอน worker เริ่มทำงาน) ช่วงนั้นเว็บอาจตอบ 502 หรือ 404 สั้นๆ ไม่ต้อง deploy ใหม่
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
| `docker compose` ฟ้องตัวแปรขาด | ตรวจ `.env` ว่าตั้ง `POSTGRES_PASSWORD` และ `ACME_EMAIL` แล้ว |
| worker ปิดตัวแล้วเริ่มใหม่วนซ้ำ | `sudo docker compose logs worker` บรรทัด `worker: …` บอกสาเหตุ มักเป็น `APPS_DOMAIN` ไม่ถูกต้อง หรือเชื่อมฐานข้อมูลไม่ได้ |
| deployment เป็น `FAILED` | `logs <deploymentId>` (id อยู่ในบรรทัด `queued deployment <id>`); เหตุผลของ deployment ที่ถูกขัดจังหวะดูได้จาก `sudo docker compose exec postgres psql -U postgres -c "select status, failure_reason from deployments order by created_at desc limit 5"` |
| HTTPS ได้ใบรับรองผิด/ขึ้นเตือน | `sudo docker compose logs traefik` ตรวจ DNS ว่าชี้ถูก และ port 80 เข้าถึงได้จากภายนอก |
| แอปถูก restart เอง / build ล้มเหลวเพราะ memory หมด | `sudo dmesg \| grep -i 'killed process'` ถ้ามีบรรทัดของแอปหรือ BuildKit แปลว่าเครื่อง memory ไม่พอ (ดูหัวข้อ "หน่วยความจำและ swap") |
| ดู container ของแอปที่ระบบจัดการ | `sudo docker ps --filter label=vpsm.managed=true` |
| ดูเพดาน memory ของ builder | `sudo docker inspect buildx_buildkit_vpsm-builder0 --format '{{.HostConfig.Memory}}'` ต้องได้ `3221225472` (3 GB; container ของ BuildKit เริ่มตอน build ครั้งแรก จึงตรวจได้หลัง deploy ครั้งแรกเท่านั้น) |

## 10. รายการตรวจหลังติดตั้งบน VPS จริง

ทำตามลำดับ เพื่อยืนยันว่าระบบทำงานครบ (ต้องใช้ VPS, DNS และ GitHub จริง):

1. **ติดตั้ง:** `sudo docker compose ps` แสดง postgres (healthy), traefik, worker เป็น running และ `sudo docker compose logs worker` ไม่มี error
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

## เมื่อ port 80/443 ถูกใช้อยู่แล้ว (เช่น Nginx Proxy Manager)

ใช้หัวข้อนี้เมื่อบน VPS มีโปรแกรมอื่นใช้ port 80/443 อยู่ และต้องให้มันทำงานต่อ (เช่น Nginx Proxy Manager) Traefik จึงรับ HTTPS ที่ port อื่นแทน (ในตัวอย่างใช้ 8443) และเพราะ Let's Encrypt แบบ HTTP challenge ต้องใช้ port 80 จึงเปลี่ยนไปขอใบรับรองด้วย DNS challenge ผ่าน DuckDNS แทน ระบบขอใบรับรอง **wildcard เพียงใบเดียว** (`*.<APPS_DOMAIN>`) ให้ทุกแอปใช้ร่วมกัน เพราะ DuckDNS เก็บ TXT record ได้ทีละค่าเดียว

ข้อกำหนด: `APPS_DOMAIN` ต้องเป็นชื่อบน DuckDNS เช่น `itexcellence.duckdns.org` (token ต้องเป็นของบัญชีที่เป็นเจ้าของชื่อนั้น) และต้องตั้ง IP ของชื่อนั้นบน DuckDNS เป็น IP ของ VPS ชื่อย่อยทุกชื่อ (`*.itexcellence.duckdns.org`) จะชี้มาที่ IP เดียวกัน

ถ้า port 80/443 ว่างอยู่ ไม่ต้องทำหัวข้อนี้ ใช้ค่าเริ่มต้นตามหัวข้อ 1–4

### ขั้นตอนบน VPS

1. เพิ่มค่าเหล่านี้ใน `.env` (ท้ายไฟล์ `.env.example` มีตัวอย่างที่ปิดด้วย `#` อยู่ ให้คัดลอกไปแล้วเอา `#` ออก):

   ```bash
   COMPOSE_FILE=docker-compose.yml:docker-compose.dns-tls.yml
   TLS_MODE=dns-wildcard
   PUBLIC_HTTPS_PORT=8443
   TRAEFIK_HTTPS_PORT=8443
   DUCKDNS_TOKEN=<token จากหน้า account ของ duckdns.org>
   ```

   Compose อ่าน `COMPOSE_FILE` จาก `.env` จึงใช้ `docker-compose.dns-tls.yml` ซ้อนบน `docker-compose.yml` ให้เองทุกครั้ง คำสั่ง `sudo docker compose …` ทั้งหมดในคู่มือนี้จึงใช้ต่อได้โดยไม่ต้องแก้ `DUCKDNS_TOKEN` เป็นความลับ ห้าม commit และห้ามแปะในที่ที่คนอื่นเห็น

2. เปิด port 8443 ใน firewall (ถ้าผู้ให้บริการ VPS มี firewall ของตัวเองด้วย ต้องเปิดที่นั่นด้วย):

   ```bash
   sudo ufw allow 8443/tcp
   ```

3. สร้าง container ใหม่:

   ```bash
   sudo docker compose up -d
   ```

   คำสั่งนี้สร้าง `traefik` และ `worker` ใหม่ ตอน worker เริ่มทำงานจะเขียน route ของแอปที่ live อยู่ใหม่ให้ใช้ใบรับรอง wildcard เอง ไม่ต้อง deploy ใหม่

4. ตรวจว่า Traefik ทำงานและได้ใบรับรอง:

   ```bash
   sudo docker compose ps
   sudo docker compose logs traefik
   ```

   `docker compose ps` ต้องแสดง `vpsm-traefik` เป็น `running` และ port เป็น `0.0.0.0:8443->443/tcp` (ไม่มี port 80 หรือ 443) การขอใบรับรองด้วย DNS challenge ใช้เวลา 1–2 นาทีหลัง Traefik เริ่ม ให้รอแล้วดู log อีกครั้ง ถ้ามีบรรทัด error ที่เกี่ยวกับ `acme` หรือ `duckdns` ให้ตรวจว่า `DUCKDNS_TOKEN` ถูกต้อง และ `APPS_DOMAIN` เป็นชื่อที่ token นั้นเป็นเจ้าของ

5. URL ของแอปจะลงท้ายด้วย `:8443` เช่น `https://hello-demo.itexcellence.duckdns.org:8443` (คำสั่ง `service:create` และ `status` รวมถึง log ของ deployment พิมพ์ URL แบบนี้ให้เอง)

ระบบขอใบรับรองแค่ใบเดียวสำหรับ `*.<APPS_DOMAIN>` ไม่ว่าจะมีกี่แอป จึงไม่ติดเพดานการออกใบรับรองของ Let's Encrypt ที่เกิดจากการขอทีละชื่อแบบโหมดปกติ
