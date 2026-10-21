# Reverse-engineering findings — Railway (railway.com)

> เป้าหมาย: เข้าใจว่า Railway ทำงานอย่างไร (data model, API, build, runtime) เพื่อสร้าง PaaS แบบเดียวกันบน VPS ของเราเอง
> ทุก claim มี coordinate (repo@commit:path:line หรือ URL) และบอกว่ารู้มาจากไหน: *source* (อ่านโค้ด), *schema* (GraphQL schema), *docs* (เอกสารทางการ), *inferred* (อนุมาน)

## 1. Target identification

| Artifact | ที่มา | Version / hash |
| --- | --- | --- |
| Railway CLI (Rust, MIT) | github.com/railwayapp/cli | commit `b62467e` (2026-10-19) |
| GraphQL schema (introspection dump ใน CLI) | `cli/src/gql/schema.json` | sha256 `3c3d1448…65f2be` — 351 object, 142 input, 97 enum |
| Railpack builder (Go, MIT) | github.com/railwayapp/railpack | commit `fc09405` (2026-10-20) |
| Nixpacks builder รุ่นเก่า (Rust, MIT) | github.com/railwayapp/nixpacks | commit `144b4f9` (2025-11-24) |
| Config-as-code JSON schema | https://railway.com/railway.schema.json | sha256 `0302fd53…2dd68f` |

ฝั่ง server (backboard, orchestrator, edge proxy) **ไม่ open-source**: เห็นได้แค่ผ่าน API schema และ docs

## 2. Scope and authorization

- **Context:** interoperability / ศึกษาสถาปัตยกรรม เพื่อสร้างระบบของเราเองบน VPS
- **ฐานความชอบธรรม:** ใช้เฉพาะโค้ด open-source (MIT), schema ที่ CLI เผยแพร่ และเอกสารสาธารณะ ไม่ได้ intercept traffic ของบัญชีใคร ไม่ได้เจาะ server
- **ข้อควรระวัง:** ห้ามคัดลอก UI, โลโก้ หรือแบรนด์ของ Railway; ห้ามใช้ชื่อโดเมน `railway.internal` และ `up.railway.app` ในระบบของเรา (ให้ใช้โดเมนของตัวเอง)

## 3. Environment and tools

- macOS, `git`, `python3 -I`, `curl`, skill script `extract_endpoints.py`
- คำสั่งหลัก: `git clone --depth 1` ทั้ง 3 repo, parse `schema.json` ด้วยสคริปต์ Python สรุป root ops และ types, `grep` ตามจุดที่สนใจ

## 4. Static findings

### 4.1 Control-plane API ("backboard")

| Coordinate | สิ่งที่พบ | Known via |
| --- | --- | --- |
| `cli/src/config.rs:407-419` | API host = `https://backboard.railway.com/graphql/v2` (staging `railway-staging.com`, dev `railway-develop.com`) | source |
| `cli/src/client.rs:28-53` | Auth ใช้ header `Authorization: Bearer <user/team token>` **หรือ** `project-access-token: <token>` (token ระดับ project+environment) และส่ง `x-source` ระบุ client | source |
| `cli/src/subscription.rs:40-63` | Realtime (logs, deployment status) = GraphQL subscription ผ่าน `wss://backboard.railway.com/graphql/v2` sub-protocol `graphql-transport-ws` | source |
| `schema.json` root ops | Query 158, Mutation 233, Subscription 13 (`buildLogs`, `deploymentLogs`, `environmentLogs`, `httpLogs`, `deployment`, `deploymentEvents`, …) | schema |

### 4.2 Data model (หัวใจของ Railway)

```
Workspace/Team
 └─ Project            (name, prDeploys, baseEnvironment)
     ├─ Environment    (production, staging, pr-123 …; config: EnvironmentConfig JSON + configEtag)
     │   ├─ ServiceInstance  = Service × Environment   ← settings อยู่ตรงนี้ ไม่ได้อยู่ที่ Service
     │   ├─ Variable          (scope: shared ระดับ environment หรือ ระดับ service)
     │   ├─ VolumeInstance    (mountPath, sizeMB, region, state)
     │   ├─ ServiceDomain / CustomDomain / TCPProxy
     │   └─ PrivateNetwork + PrivateNetworkEndpoint (dnsName, privateIps)
     ├─ Service        (name, icon, source repo|image)
     ├─ Volume
     └─ Deployment     (status, meta, instances[]) ← 1 deploy = 1 build+run ของ ServiceInstance
```

Fields สำคัญ (schema, type `ServiceInstance`):
`source{repo|image}`, `rootDirectory`, `builder` (`RAILPACK|NIXPACKS|HEROKU|PAKETO`), `buildCommand`, `dockerfilePath`, `startCommand`, `preDeployCommand`, `healthcheckPath`, `healthcheckTimeout`, `numReplicas`, `region`, `restartPolicyType` (`ALWAYS|NEVER|ON_FAILURE`), `restartPolicyMaxRetries`, `cronSchedule`, `sleepApplication`, `overlapSeconds`, `drainingSeconds`, `watchPatterns`, `railwayConfigFile`

`DeploymentStatus` (schema): `QUEUED → INITIALIZING → BUILDING → DEPLOYING → SUCCESS` และสถานะข้าง `WAITING`, `NEEDS_APPROVAL`, `SKIPPED`, `FAILED`, `CRASHED`, `SLEEPING`, `REMOVING`, `REMOVED`

`TCPProxy` (schema): `domain` + `proxyPort` (public) → `applicationPort` (ใน container)

### 4.3 EnvironmentConfig = declarative desired-state

| Coordinate | สิ่งที่พบ | Known via |
| --- | --- | --- |
| `cli/src/iac/compiler.rs:370` `graph_to_environment_config` | ทั้ง environment ถูกแทนด้วย JSON ก้อนเดียว `{services, volumes, buckets, groups}` | source |
| `cli/src/iac/compiler.rs:564` `service_to_environment_config` | ต่อ service: `source{repo,branch,image,rootDirectory,commitSha,autoUpdates}`, `build`, `deploy`, `variables`, `networking`, `volumeMounts{<volumeId>:{mountPath}}` | source |
| schema mutations `environmentStageChanges`, `environmentPatchCommit`, `environmentApplyChangeSet` | แก้ config แบบ stage → review → commit (มี `configEtag` กัน write ชนกัน) | schema |
| `cli/src/util/cac_deprecation.rs:160` | `railway.json`/`railway.toml` ถูก deprecate แล้ว แนะนำ `.railway/railway.ts` (IaC) แทน | source |

ตัวอย่าง shape (อนุมานจาก compiler.rs):
```json
{
  "services": {
    "<serviceId>": {
      "source": { "repo": "owner/app", "branch": "main" },
      "build":  { "builder": "RAILPACK", "buildCommand": "npm run build" },
      "deploy": { "startCommand": "node server.js", "healthcheckPath": "/health",
                  "numReplicas": 1, "restartPolicyType": "ON_FAILURE" },
      "variables": { "DATABASE_URL": { "value": "${{Postgres.DATABASE_URL}}" } },
      "networking": { "serviceDomains": {}, "tcpProxies": { "5432": {} } },
      "volumeMounts": { "<volumeId>": { "mountPath": "/data" } }
    }
  },
  "volumes": { "<volumeId>": { "isCreated": true } }
}
```
(`networking` มี key `serviceDomains`, `customDomains`, `tcpProxies` — เห็นที่ `cli/src/iac/json.rs:69` และ `compiler.rs:553`; โครงสร้างข้างใน `serviceDomains` ยังไม่ได้ตรวจ)

### 4.4 Variables และ reference

| Coordinate | สิ่งที่พบ | Known via |
| --- | --- | --- |
| `cli/src/iac/compiler.rs:512-560` | syntax อ้างอิง `${{VAR}}` (service เดียวกัน) และ `${{Service.VAR}}` (ข้าม service); รองรับ `generator: secret(32, "<charset>")` สร้างรหัสผ่านอัตโนมัติ | source |
| CLI grep `RAILWAY_*` | ตัวแปรที่ platform inject: `RAILWAY_PRIVATE_DOMAIN`, `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_TCP_PROXY_DOMAIN`, `RAILWAY_TCP_PROXY_PORT`, `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID/NAME`, `RAILWAY_SERVICE_ID/NAME`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | source |
| schema `VariableCollectionUpsertInput.skipDeploys` | แก้ตัวแปรแล้ว default = redeploy อัตโนมัติ | schema |

### 4.5 Database = template ธรรมดา (ไม่ใช่ managed DB พิเศษ)

`cli/src/iac/compiler.rs:512` `database_to_environment_config`: Postgres = image (`ghcr.io/railwayapp-templates/postgres-ssl:18`) + volume mount `/var/lib/postgresql/data` + ชุดตัวแปร (`PGHOST=${{RAILWAY_PRIVATE_DOMAIN}}`, `POSTGRES_PASSWORD` จาก generator, `DATABASE_URL`, `DATABASE_PUBLIC_URL` ผ่าน TCP proxy) + `tcpProxies: {5432}` — *source*
Redis ใช้ `ghcr.io/railwayapp-templates/redis:8` — *source*

### 4.6 Deploy จากเครื่อง (`railway up`)

| Coordinate | สิ่งที่พบ | Known via |
| --- | --- | --- |
| `cli/src/controllers/upload.rs:33` | สร้าง `.tar.gz` ของ directory ตาม `.gitignore` + `.railwayignore`, ตัด `.git` และ `node_modules` เสมอ | source |
| `cli/src/controllers/upload.rs:89-126` | `POST https://backboard.railway.com/project/{projectId}/environment/{environmentId}/up?serviceId=…&message=…` body = gzip tarball, `Content-Type: application/gzip`; ตอบกลับ `deploymentDomain` + id | source |
| `cli/src/commands/up.rs:340` | หลัง upload รอเล็กน้อยแล้วต่อ log stream (subscription) | source |

### 4.7 Build pipeline (Railpack — ใช้ตรงๆ ได้เลย)

`railpack/docs/src/content/docs/platforms/running-railpack-in-production.mdx` — *docs*

1. `railpack prepare <dir> --plan-out railpack-plan.json --info-out railpack-info.json` ตรวจภาษาและสร้าง build plan (exit 75 = retry ได้, exit 1 = fail ถาวร)
2. Build ผ่าน BuildKit frontend `ghcr.io/railwayapp/railpack-frontend` (ไม่ต้องมี Dockerfile)
3. Secrets ส่งเป็น BuildKit `--secret`, ส่ง `secrets-hash` เพื่อ invalidate layer, และ `cache-key` เพื่อแยก cache ต่อ tenant
4. รองรับ: node, bun, deno, python, go, rust, java, php, ruby, elixir, dotnet, gleam, zig, cpp, staticfile, shell, procfile (`railpack/core/providers/`)

### 4.8 Networking (ภายนอกและภายใน)

| สิ่งที่พบ | Coordinate | Known via |
| --- | --- | --- |
| Public HTTP: `<name>.up.railway.app` + custom domain (CNAME check, cert อัตโนมัติ) | schema `ServiceDomain`, `CustomDomain.cnameCheck`, mutation `customDomainIssueCertificate` | schema |
| Public TCP: `<x>.proxy.rlwy.net:<random port>` → port ใน container | `cli/src/commands/connect.rs:235`, schema `TCPProxy` | source/schema |
| Private: `<service>.railway.internal`, WireGuard mesh ต่อ environment, ใช้ได้เฉพาะ runtime ไม่ใช่ตอน build | docs.railway.com/networking/private-networking/how-it-works | docs |
| SSH เข้า container ผ่าน relay `ssh.railway.com` | `cli/src/config.rs:427`, `cli/src/commands/ssh/config.rs:275` | source |
| Edge proxy L4/L7 เขียนเอง (แทน Envoy), orchestrator เขียนเอง + Kubernetes บางส่วน, bare metal | blog.railway.com/p/team-spotlight-infrastructure-engineering, railway.com/careers/orchestration-baremetal | docs (ระดับ blog/job post ไม่ใช่ spec) |

## 5. Dynamic findings

ยังไม่ได้ทำ (ไม่ได้ intercept traffic จริง) ถ้าต้องการยืนยัน: login CLI ด้วยบัญชีตัวเอง แล้วรัน `mitmproxy` + `HTTPS_PROXY=… railway up` เพื่อดู request/response จริงของ `/up` และ subscription frames

## 6. Mapping: Railway → VPS ของเรา

| ความสามารถของ Railway | ตัวที่ใช้แทนบน VPS (open-source) |
| --- | --- |
| Backboard GraphQL API + EnvironmentConfig | API server ของเราเอง (Node/Go) + Postgres เก็บ Project/Environment/Service/Deployment; เก็บ config เป็น JSON desired-state เหมือนข้อ 4.3 |
| Build (Railpack) | `railpack prepare` + BuildKit (`moby/buildkit`) + frontend `ghcr.io/railwayapp/railpack-frontend` → push เข้า local registry (`registry:2`) |
| GitHub auto-deploy | GitHub App/webhook → enqueue deployment (`watchPatterns`, `rootDirectory`) |
| Runtime / orchestrator | VPS เดียว: Docker Engine (`docker run` ตาม desired-state); หลายเครื่อง: Docker Swarm, Nomad หรือ k3s |
| Zero-downtime (`overlapSeconds`, `drainingSeconds`, healthcheck) | start container ใหม่ → รอ healthcheck ผ่าน → สลับ route ใน proxy → รอ drain → หยุดตัวเก่า |
| Public domain + auto TLS | Traefik หรือ Caddy (on-demand TLS) + wildcard DNS `*.apps.yourdomain.com` |
| TCP proxy | Traefik TCP router / HAProxy เปิด port สุ่ม → container port |
| Private network `*.railway.internal` | Docker network หนึ่งอันต่อ environment + network alias `<service>.internal`; ข้ามเครื่องใช้ WireGuard (หรือ Swarm overlay) |
| Variables + `${{Service.VAR}}` | resolver ฝั่ง API ก่อน start container; inject `APP_PRIVATE_DOMAIN`, `APP_PUBLIC_DOMAIN` ฯลฯ |
| Volumes + backups | Docker named volume + `restic` ไป S3/Backblaze ตาม schedule |
| Databases (template) | template JSON: image + volume + variables + tcpProxy แบบเดียวกับข้อ 4.5 |
| Logs realtime | `docker logs -f` / Vector → Loki; ส่งต่อ UI ผ่าน WebSocket (GraphQL `graphql-transport-ws` หรือ SSE) |
| Restart policy, cron, replicas | Docker `--restart`, scheduler (cron) สั่ง run-once container, `numReplicas` = จำนวน container หลัง proxy |
| PR environments | webhook PR opened → clone environment config → deploy → ลบเมื่อ PR ปิด |
| `railway up` | endpoint `POST /project/:p/environment/:e/up` รับ tar.gz แบบเดียวกัน |

## 7. Behavior summary

Railway = **control plane** (GraphQL API ถือ desired-state ต่อ environment) + **build plane** (Railpack บน BuildKit, open-source) + **data plane** (orchestrator, edge proxy L4/L7, WireGuard private network; closed-source) ทุกอย่างที่ผู้ใช้เห็นเป็นแค่การแก้ JSON ของ environment แล้วระบบ reconcile ให้ตรง

## 8. Open questions / next steps

- ทางลัด: มี self-hosted PaaS ที่ทำแบบนี้อยู่แล้ว เช่น Coolify, Dokploy, CapRover, Dokku (*inferred จากความรู้เดิม ยังไม่ได้ตรวจใน session นี้*) ถ้าแค่อยาก "ใช้" ให้ลองตัวพวกนี้ก่อนเขียนเอง
- ถ้าจะสร้างเอง: เริ่ม PoC 3 ขั้น (1) `railpack prepare` + `buildctl` build จาก repo บน VPS (2) API เล็กๆ เก็บ Service + Deployment แล้วรัน container (3) Traefik route `<service>.<domain>` อัตโนมัติ
- ยังไม่ยืนยัน: โครงสร้างข้างใน `serviceDomains`, รูปแบบ response เต็มของ `/up`, วิธีที่ Railway ทำ sleep/wake (`sleepApplication`)
