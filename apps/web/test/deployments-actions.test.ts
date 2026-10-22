import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  claimNextDeployment,
  createAppService,
  createProject,
  createUser,
  enqueueDeployment,
  setDeploymentStatus,
  type Actor,
  type SafeUser,
} from '@vpsm/db'
import { setupTestDb } from '@vpsm/db/testing'
import { doDeploy, doRestart, doRollback } from '@/server/deployments'
import { NotFoundError } from '@/server/errors'
import { PASSWORD } from './helpers'

let t: Awaited<ReturnType<typeof setupTestDb>>
beforeAll(async () => {
  t = await setupTestDb()
})
afterAll(async () => {
  await t?.close()
})
afterEach(() => {
  vi.restoreAllMocks()
})

const SITE = { httpsPort: 443 }
const NO_IMAGE = 'this deployment has no image to roll back to'
const NOTHING_RUNNING = 'nothing is running to restart'
const ALREADY_QUEUED = 'a deployment is already queued for this service'
const ALREADY_RUNNING = 'this deployment is already running — use Restart'

let ada: SafeUser
let bob: SafeUser
let root: SafeUser
const actorOf = (user: SafeUser): Actor => ({ id: user.id, role: user.role })

beforeEach(async () => {
  await t.reset()
  const make = (email: string, name: string, role: 'admin' | 'member') =>
    createUser(t.db, { email, name, role, password: PASSWORD })
  ada = await make('ada@example.com', 'Ada', 'member')
  bob = await make('bob@example.com', 'Bob', 'member')
  root = await make('root@example.com', 'Root', 'admin')
})

const auditRows = () => t.sql`select actor_id, action, target_type, target_id, metadata from audit_events order by id`
const deploymentRows = () =>
  t.sql`select id, trigger, status, created_by_id, rollback_of_id, service_instance_id from deployments order by created_at, id`
const triggers = async () => (await deploymentRows()).map((row) => row.trigger)

async function addService(projectName: string, serviceName: string) {
  const { instance } = await createAppService(t.db, {
    projectName,
    serviceName,
    source: { repo: 'acme/web', branch: 'main' },
    appsDomain: 'apps.example.com',
  })
  return instance
}
// Ada's project `shop` with a service `web`; returns the instance the deployments belong to.
async function shopWithWeb() {
  await createProject(t.db, 'shop', ada.id)
  return addService('shop', 'web')
}

// A deployment that went all the way: `SUCCESS` (live) with an image, or `FAILED`/`CRASHED` after building one.
async function finish(instanceId: string, how: 'live' | 'failed-with-image' | 'failed' | 'crashed', imageTag = `img:${Math.random()}`) {
  const queued = await enqueueDeployment(t.db, { serviceInstanceId: instanceId, trigger: 'push' })
  await claimNextDeployment(t.db)
  await setDeploymentStatus(t.db, queued.id, 'BUILDING')
  if (how === 'failed') {
    await setDeploymentStatus(t.db, queued.id, 'FAILED', { failureReason: 'build failed' })
    return queued
  }
  await setDeploymentStatus(t.db, queued.id, 'DEPLOYING', { imageTag })
  if (how === 'failed-with-image') {
    await setDeploymentStatus(t.db, queued.id, 'FAILED', { failureReason: 'health check failed' })
    return queued
  }
  await setDeploymentStatus(t.db, queued.id, 'SUCCESS', { containerName: `vpsm-${queued.id}` })
  if (how === 'crashed') await setDeploymentStatus(t.db, queued.id, 'CRASHED')
  return queued
}

const ACTIONS: [string, (actor: Actor, project: string, service: string) => Promise<unknown>][] = [
  ['doDeploy', (actor, project, service) => doDeploy(t.db, actor, project, service, SITE)],
  ['doRestart', (actor, project, service) => doRestart(t.db, actor, project, service, SITE)],
  ['doRollback', (actor, project, service) => doRollback(t.db, actor, project, service, '00000000-0000-4000-8000-000000000001', SITE)],
]

describe.each(ACTIONS)('%s: who may use it', (_name, run) => {
  test('someone outside the project gets NotFound and nothing is queued or audited', async () => {
    const instance = await shopWithWeb()
    await finish(instance.id, 'live')
    const before = await deploymentRows()
    await expect(run(actorOf(bob), 'shop', 'web')).rejects.toBeInstanceOf(NotFoundError)
    expect(await deploymentRows()).toEqual(before)
    expect(await auditRows()).toEqual([])
  })

  test('a project or service that does not exist, or a name that is not a name, is the same NotFound', async () => {
    await shopWithWeb()
    for (const [project, service] of [
      ['nothing', 'web'],
      ['shop', 'nothing'],
      ['Shop', 'web'],
      ['shop', 'WEB'],
      ['', ''],
      ['shop', "'; drop table deployments; --"],
    ] as const) {
      await expect(run(actorOf(ada), project, service)).rejects.toBeInstanceOf(NotFoundError)
    }
    await expect(run(actorOf(ada), 42 as unknown as string, 'web')).rejects.toBeInstanceOf(NotFoundError)
    await expect(run(actorOf(ada), 'shop', undefined as unknown as string)).rejects.toBeInstanceOf(NotFoundError)
    expect(await deploymentRows()).toEqual([])
    expect(await auditRows()).toEqual([])
  })

  test('a service of another project that has the same name is not reachable through this project', async () => {
    await shopWithWeb()
    await createProject(t.db, 'blog', bob.id)
    await addService('blog', 'docs')
    await expect(run(actorOf(ada), 'shop', 'docs')).rejects.toBeInstanceOf(NotFoundError)
    await expect(run(actorOf(ada), 'blog', 'docs')).rejects.toBeInstanceOf(NotFoundError)
    expect(await deploymentRows()).toEqual([])
  })
})

describe('doDeploy', () => {
  test('queues a manual deployment created by the actor and records deployment.deploy with its id', async () => {
    const instance = await shopWithWeb()
    expect(await doDeploy(t.db, actorOf(ada), 'shop', 'web', SITE)).toEqual({ notice: 'Deployment queued.' })

    const rows = await deploymentRows()
    expect(rows).toEqual([
      {
        id: expect.any(String),
        trigger: 'manual',
        status: 'QUEUED',
        created_by_id: ada.id,
        rollback_of_id: null,
        service_instance_id: instance.id,
      },
    ])
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'deployment.deploy',
        target_type: 'deployment',
        target_id: rows[0]!.id,
        metadata: { project: 'shop', service: 'web' },
      },
    ])
  })

  test('an admin who is not a member may deploy', async () => {
    await shopWithWeb()
    expect(await doDeploy(t.db, actorOf(root), 'shop', 'web', SITE)).toEqual({ notice: 'Deployment queued.' })
    expect((await deploymentRows())[0]).toMatchObject({ trigger: 'manual', created_by_id: root.id })
  })

  test('a deployment that is still waiting is replaced by the new one, as for a push', async () => {
    const instance = await shopWithWeb()
    await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'push' })
    await doDeploy(t.db, actorOf(ada), 'shop', 'web', SITE)
    expect((await deploymentRows()).map((row) => [row.trigger, row.status])).toEqual([
      ['push', 'SKIPPED'],
      ['manual', 'QUEUED'],
    ])
  })

  test('the audit event is a record: when it cannot be written, the deployment stands, and the failure is logged without the statement', async () => {
    await shopWithWeb()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.sql`alter table audit_events rename to audit_events_away`
    try {
      expect(await doDeploy(t.db, actorOf(ada), 'shop', 'web', SITE)).toEqual({ notice: 'Deployment queued.' })
    } finally {
      await t.sql`alter table audit_events_away rename to audit_events`
    }
    expect(await triggers()).toEqual(['manual'])
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0]![0])).toContain('recording deployment.deploy')
    expect(String(log.mock.calls[0]![0])).not.toContain('params')
  })
})

describe('doRestart', () => {
  test('queues a restart of the live deployment, created by the actor, and records deployment.restart', async () => {
    const instance = await shopWithWeb()
    const live = await finish(instance.id, 'live')
    expect(await doRestart(t.db, actorOf(ada), 'shop', 'web', SITE)).toEqual({ notice: 'Restart queued.' })

    const rows = await deploymentRows()
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({
      trigger: 'restart',
      status: 'QUEUED',
      created_by_id: ada.id,
      rollback_of_id: live.id,
      service_instance_id: instance.id,
    })
    expect(rows[0]).toMatchObject({ id: live.id, status: 'SUCCESS' })
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'deployment.restart',
        target_type: 'deployment',
        target_id: rows[1]!.id,
        metadata: { project: 'shop', service: 'web', rollbackOfId: live.id },
      },
    ])
  })

  test('restarts the newest live deployment when older ones were replaced', async () => {
    const instance = await shopWithWeb()
    const older = await finish(instance.id, 'live')
    const newer = await finish(instance.id, 'live')
    await doRestart(t.db, actorOf(ada), 'shop', 'web', SITE)
    const restart = (await deploymentRows()).find((row) => row.trigger === 'restart')
    expect(restart!.rollback_of_id).toBe(newer.id)
    expect(restart!.rollback_of_id).not.toBe(older.id)
  })

  test.each([
    ['a service never deployed', async (_instanceId: string) => {}],
    ['one whose only deployment failed', async (instanceId: string) => void (await finish(instanceId, 'failed'))],
    ['one whose only deployment failed after building an image', async (instanceId: string) => void (await finish(instanceId, 'failed-with-image'))],
    ['one whose live deployment crashed', async (instanceId: string) => void (await finish(instanceId, 'crashed'))],
    [
      'one that only has a deployment waiting',
      async (instanceId: string) => void (await enqueueDeployment(t.db, { serviceInstanceId: instanceId, trigger: 'manual' })),
    ],
  ])('with nothing running (%s) it says so and queues nothing', async (_name, prepare) => {
    const instance = await shopWithWeb()
    await prepare(instance.id)
    const before = await deploymentRows()
    expect(await doRestart(t.db, actorOf(ada), 'shop', 'web', SITE)).toEqual({ error: NOTHING_RUNNING })
    expect(await deploymentRows()).toEqual(before)
    expect(await auditRows()).toEqual([])
  })

  test('while a deployment is waiting it is refused with the message of the queue, and that deployment is not touched', async () => {
    const instance = await shopWithWeb()
    await finish(instance.id, 'live')
    const waiting = await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'push' })
    const before = await deploymentRows()

    expect(await doRestart(t.db, actorOf(ada), 'shop', 'web', SITE)).toEqual({ error: ALREADY_QUEUED })
    expect(await deploymentRows()).toEqual(before)
    expect((await deploymentRows()).find((row) => row.id === waiting.id)).toMatchObject({ status: 'QUEUED' })
    expect(await auditRows()).toEqual([])
  })

  test('a second Restart while the first is still waiting is refused the same way', async () => {
    const instance = await shopWithWeb()
    await finish(instance.id, 'live')
    expect(await doRestart(t.db, actorOf(ada), 'shop', 'web', SITE)).toEqual({ notice: 'Restart queued.' })
    expect(await doRestart(t.db, actorOf(ada), 'shop', 'web', SITE)).toEqual({ error: ALREADY_QUEUED })
    expect(await triggers()).toEqual(['push', 'restart'])
    expect(await auditRows()).toHaveLength(1)
  })

  test('only the service asked for is looked at: the live deployment of another service does not count', async () => {
    const web = await shopWithWeb()
    const api = await addService('shop', 'api')
    await finish(api.id, 'live')
    expect(await doRestart(t.db, actorOf(ada), 'shop', 'web', SITE)).toEqual({ error: NOTHING_RUNNING })
    expect(await deploymentRows()).toHaveLength(1)
    expect((await deploymentRows())[0]).toMatchObject({ service_instance_id: api.id })
    expect(web.id).not.toBe(api.id)
  })
})

describe('doRollback', () => {
  test('queues a rollback to that deployment, created by the actor, and records deployment.rollback', async () => {
    const instance = await shopWithWeb()
    const old = await finish(instance.id, 'live', 'img:old')
    await finish(instance.id, 'live', 'img:new')
    expect(await doRollback(t.db, actorOf(ada), 'shop', 'web', old.id, SITE)).toEqual({ notice: 'Rollback queued.' })

    const rows = await deploymentRows()
    expect(rows).toHaveLength(3)
    expect(rows[2]).toMatchObject({
      trigger: 'rollback',
      status: 'QUEUED',
      created_by_id: ada.id,
      rollback_of_id: old.id,
      service_instance_id: instance.id,
    })
    expect(await auditRows()).toEqual([
      {
        actor_id: ada.id,
        action: 'deployment.rollback',
        target_type: 'deployment',
        target_id: rows[2]!.id,
        metadata: { project: 'shop', service: 'web', rollbackOfId: old.id },
      },
    ])
  })

  test('the deployment that is live is refused with a pointer to Restart, and nothing is queued or audited', async () => {
    const instance = await shopWithWeb()
    await finish(instance.id, 'live', 'img:old')
    const live = await finish(instance.id, 'live', 'img:new')
    const before = await deploymentRows()
    expect(await doRollback(t.db, actorOf(ada), 'shop', 'web', live.id, SITE)).toEqual({ error: ALREADY_RUNNING })
    expect(await deploymentRows()).toEqual(before)
    expect(await auditRows()).toEqual([])
  })

  test('a deployment that was live and has been replaced is not refused', async () => {
    const instance = await shopWithWeb()
    const old = await finish(instance.id, 'live', 'img:old')
    await finish(instance.id, 'live', 'img:new')
    expect(await doRollback(t.db, actorOf(ada), 'shop', 'web', old.id, SITE)).toEqual({ notice: 'Rollback queued.' })
  })

  test('a crashed deployment has no live one, so it can be rolled back to', async () => {
    const instance = await shopWithWeb()
    const crashed = await finish(instance.id, 'crashed')
    expect(await doRollback(t.db, actorOf(ada), 'shop', 'web', crashed.id, SITE)).toEqual({ notice: 'Rollback queued.' })
  })

  test('a deployment that failed after building its image can be rolled back to', async () => {
    const instance = await shopWithWeb()
    const failed = await finish(instance.id, 'failed-with-image')
    expect(await doRollback(t.db, actorOf(ada), 'shop', 'web', failed.id, SITE)).toEqual({ notice: 'Rollback queued.' })
    expect(await triggers()).toEqual(['push', 'rollback'])
  })

  test('a deployment of this service without an image is refused with the reason, and nothing is queued', async () => {
    const instance = await shopWithWeb()
    const failed = await finish(instance.id, 'failed')
    const waiting = await enqueueDeployment(t.db, { serviceInstanceId: instance.id, trigger: 'manual' })
    for (const target of [failed, waiting]) {
      expect(await doRollback(t.db, actorOf(ada), 'shop', 'web', target.id, SITE)).toEqual({ error: NO_IMAGE })
    }
    expect(await triggers()).toEqual(['push', 'manual'])
    expect(await auditRows()).toEqual([])
  })

  test('a deployment of another service of the same project is NotFound, whether or not it has an image', async () => {
    const web = await shopWithWeb()
    const api = await addService('shop', 'api')
    const withImage = await finish(api.id, 'live')
    const withoutImage = await finish(api.id, 'failed')
    await finish(web.id, 'live')
    const before = await deploymentRows()
    for (const target of [withImage, withoutImage]) {
      await expect(doRollback(t.db, actorOf(ada), 'shop', 'web', target.id, SITE)).rejects.toBeInstanceOf(NotFoundError)
    }
    expect(await deploymentRows()).toEqual(before)
    expect(await auditRows()).toEqual([])
  })

  test('a deployment of another project is NotFound, also when the actor can see that project', async () => {
    await shopWithWeb()
    await createProject(t.db, 'blog', ada.id)
    const docs = await addService('blog', 'web')
    const foreign = await finish(docs.id, 'live')
    await createProject(t.db, 'secret', bob.id)
    const hidden = await finish((await addService('secret', 'web')).id, 'live')
    for (const target of [foreign, hidden]) {
      await expect(doRollback(t.db, actorOf(ada), 'shop', 'web', target.id, SITE)).rejects.toBeInstanceOf(NotFoundError)
    }
    expect(await triggers()).toEqual(['push', 'push'])
    expect(await auditRows()).toEqual([])
  })

  test('an id that is no deployment (unknown, not a uuid, not text) is NotFound without a database error', async () => {
    await shopWithWeb()
    for (const id of ['00000000-0000-4000-8000-000000000000', 'not-a-uuid', '', "' or true --", undefined, null, 7, {}, ['x']]) {
      await expect(doRollback(t.db, actorOf(ada), 'shop', 'web', id as unknown as string, SITE)).rejects.toBeInstanceOf(NotFoundError)
    }
    expect(await deploymentRows()).toEqual([])
  })

  test('the project is checked before the deployment: an outsider cannot tell a real id from a made up one', async () => {
    const instance = await shopWithWeb()
    const real = await finish(instance.id, 'live')
    const outcomes = []
    for (const id of [real.id, '00000000-0000-4000-8000-000000000000']) {
      outcomes.push(await doRollback(t.db, actorOf(bob), 'shop', 'web', id, SITE).catch((error: unknown) => error))
    }
    expect(outcomes.every((outcome) => outcome instanceof NotFoundError)).toBe(true)
    expect(await triggers()).toEqual(['push'])
  })

  test('an admin who is not a member may roll back', async () => {
    const instance = await shopWithWeb()
    const old = await finish(instance.id, 'live')
    await finish(instance.id, 'live')
    expect(await doRollback(t.db, actorOf(root), 'shop', 'web', old.id, SITE)).toEqual({ notice: 'Rollback queued.' })
    expect((await deploymentRows()).find((row) => row.trigger === 'rollback')).toMatchObject({ created_by_id: root.id })
  })
})
