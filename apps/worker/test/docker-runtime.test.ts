import { PassThrough } from 'node:stream'
import type Dockerode from 'dockerode'
import { describe, expect, test, vi } from 'vitest'
import { createDockerRuntime } from '../src/runtime/docker-runtime'

const dockerError = (statusCode: number, message = 'docker error') => Object.assign(new Error(message), { statusCode })
const fake = (parts: object) => parts as unknown as Dockerode
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('onContainerDie', () => {
  function subscribe() {
    const stream = new PassThrough()
    const getEvents = vi.fn(async () => stream)
    const names: string[] = []
    const onError = vi.fn()
    const unsubscribe = createDockerRuntime(fake({ getEvents })).onContainerDie((name) => names.push(name), onError)
    return { stream, getEvents, names, onError, unsubscribe }
  }
  const die = (name: string) => JSON.stringify({ Type: 'container', Action: 'die', Actor: { ID: 'abc', Attributes: { name, exitCode: '1' } } })

  test('asks only for die events of managed containers', async () => {
    const { getEvents, unsubscribe } = subscribe()
    await tick()
    expect(getEvents).toHaveBeenCalledWith({ filters: { type: ['container'], event: ['die'], label: ['vpsm.managed=true'] } })
    unsubscribe()
  })

  test('reports the container name from each event, even when chunks split lines', async () => {
    const { stream, names, onError, unsubscribe } = subscribe()
    await tick()
    const payload = `${die('vpsm-web-1')}\n${die('vpsm-api-2')}\n${die('vpsm-é-3')}\n`
    const bytes = Buffer.from(payload)
    // Cut inside the first line and inside the two-byte "é".
    const cuts = [10, bytes.indexOf(0xc3) + 1, bytes.length]
    let from = 0
    for (const to of cuts) {
      stream.write(bytes.subarray(from, to))
      from = to
    }
    await tick()
    expect(names).toEqual(['vpsm-web-1', 'vpsm-api-2', 'vpsm-é-3'])
    expect(onError).not.toHaveBeenCalled()
    unsubscribe()
  })

  test('skips garbage lines and events without a name', async () => {
    const { stream, names, onError, unsubscribe } = subscribe()
    await tick()
    stream.write(`not json\n\n{"Actor":{}}\n${die('vpsm-ok')}\n`)
    await tick()
    expect(names).toEqual(['vpsm-ok'])
    expect(onError).not.toHaveBeenCalled()
    unsubscribe()
  })

  test('unsubscribe destroys the stream and silences further events', async () => {
    const { stream, names, onError, unsubscribe } = subscribe()
    await tick()
    unsubscribe()
    expect(stream.destroyed).toBe(true)
    stream.write(`${die('late')}\n`)
    await tick()
    expect(names).toEqual([])
    expect(onError).not.toHaveBeenCalled()
  })

  test('unsubscribing before the stream is open destroys it once it opens', async () => {
    const stream = new PassThrough()
    const unsubscribe = createDockerRuntime(fake({ getEvents: async () => stream })).onContainerDie(() => {})
    unsubscribe()
    await tick()
    expect(stream.destroyed).toBe(true)
  })

  test('surfaces a failed subscription, a dropped stream and a throwing callback via onError', async () => {
    const failing = vi.fn()
    createDockerRuntime(fake({ getEvents: async () => Promise.reject(new Error('daemon down')) })).onContainerDie(() => {}, failing)
    await tick()
    expect(failing).toHaveBeenCalledWith(expect.objectContaining({ message: 'daemon down' }))

    const stream = new PassThrough()
    const onError = vi.fn()
    createDockerRuntime(fake({ getEvents: async () => stream })).onContainerDie(() => {
      throw new Error('callback bug')
    }, onError)
    await tick()
    stream.write(`${die('vpsm-x')}\n`)
    await tick()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'callback bug' }))
    stream.destroy()
    await tick()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'docker event stream closed' }))
  })
})

describe('listManaged', () => {
  test('lists all managed containers with parsed labels', async () => {
    const listContainers = vi.fn(async () => [
      {
        Names: ['/vpsm-web-1'],
        State: 'running',
        Labels: { 'vpsm.managed': 'true', 'vpsm.deployment-id': 'd1', 'vpsm.service-instance-id': 'si1', 'vpsm.memory-mb': '512' },
      },
      { Names: ['/vpsm-api-2'], State: 'exited', Labels: { 'vpsm.managed': 'true', 'vpsm.memory-mb': 'lots' } },
      { Names: ['/vpsm-old-3'], State: 'restarting', Labels: { 'vpsm.managed': 'true' } },
    ])
    const list = await createDockerRuntime(fake({ listContainers })).listManaged()
    expect(listContainers).toHaveBeenCalledWith({ all: true, filters: { label: ['vpsm.managed=true'] } })
    expect(list).toEqual([
      { name: 'vpsm-web-1', deploymentId: 'd1', serviceInstanceId: 'si1', memoryMb: 512, running: true },
      { name: 'vpsm-api-2', deploymentId: '', serviceInstanceId: '', memoryMb: 0, running: false },
      { name: 'vpsm-old-3', deploymentId: '', serviceInstanceId: '', memoryMb: 0, running: true },
    ])
  })
})

describe('state', () => {
  test('a missing container is not an error', async () => {
    const docker = fake({ getContainer: () => ({ inspect: async () => Promise.reject(dockerError(404)) }) })
    expect(await createDockerRuntime(docker).state('nope')).toEqual({
      exists: false,
      running: false,
      restarting: false,
      exitCode: 0,
      restartCount: 0,
      restartPolicy: '',
      maxRetries: 0,
    })
  })

  test('maps inspect output and rethrows other failures', async () => {
    const inspect = async () => ({
      State: { Running: true, Restarting: true, ExitCode: 3 },
      RestartCount: 4,
      HostConfig: { RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 10 } },
    })
    expect(await createDockerRuntime(fake({ getContainer: () => ({ inspect }) })).state('c')).toEqual({
      exists: true,
      running: true,
      restarting: true,
      exitCode: 3,
      restartCount: 4,
      restartPolicy: 'on-failure',
      maxRetries: 10,
    })
    const broken = fake({ getContainer: () => ({ inspect: async () => Promise.reject(dockerError(500, 'boom')) }) })
    await expect(createDockerRuntime(broken).state('c')).rejects.toThrow('boom')
  })
})

describe('run', () => {
  test('refuses to replace an existing container instead of removing it', async () => {
    const createContainer = vi.fn()
    const docker = fake({ getContainer: () => ({ inspect: async () => ({}) }), createContainer })
    await expect(createDockerRuntime(docker).run({ name: 'vpsm-dup', Image: 'x' })).rejects.toThrow('container vpsm-dup already exists')
    expect(createContainer).not.toHaveBeenCalled()
  })

  test('removes the container again when it fails to start', async () => {
    const remove = vi.fn(async () => {})
    const container = { start: async () => Promise.reject(new Error('exec not found')), remove }
    const docker = fake({
      getContainer: () => ({ inspect: async () => Promise.reject(dockerError(404)) }),
      createContainer: async () => container,
    })
    await expect(createDockerRuntime(docker).run({ name: 'vpsm-x', Image: 'x' })).rejects.toThrow('exec not found')
    expect(remove).toHaveBeenCalledWith({ force: true, v: true })
  })
})

describe('stopAndRemove', () => {
  test('stops with the timeout then force-removes it together with its anonymous volumes', async () => {
    const calls: string[] = []
    const container = {
      stop: async (o: object) => void calls.push(`stop ${JSON.stringify(o)}`),
      remove: async (o: object) => void calls.push(`remove ${JSON.stringify(o)}`),
    }
    await createDockerRuntime(fake({ getContainer: () => container })).stopAndRemove('c', 10)
    expect(calls).toEqual(['stop {"t":10}', 'remove {"force":true,"v":true}'])
  })

  test('is a no-op for a missing container and tolerates one that is not running', async () => {
    const missing = { stop: async () => Promise.reject(dockerError(404)), remove: async () => Promise.reject(dockerError(404)) }
    await expect(createDockerRuntime(fake({ getContainer: () => missing })).stopAndRemove('c', 1)).resolves.toBeUndefined()

    const remove = vi.fn(async () => {})
    const stopped = { stop: async () => Promise.reject(dockerError(304)), remove }
    await createDockerRuntime(fake({ getContainer: () => stopped })).stopAndRemove('c', 1)
    expect(remove).toHaveBeenCalled()
  })

  test('rethrows real failures', async () => {
    const broken = { stop: async () => Promise.reject(dockerError(500, 'daemon error')), remove: vi.fn() }
    await expect(createDockerRuntime(fake({ getContainer: () => broken })).stopAndRemove('c', 1)).rejects.toThrow('daemon error')
    expect(broken.remove).not.toHaveBeenCalled()
  })
})

describe('removeImage', () => {
  const runtimeFailing = (statusCode: number) =>
    createDockerRuntime(fake({ getImage: () => ({ remove: async () => Promise.reject(dockerError(statusCode, `status ${statusCode}`)) }) }))

  test('swallows not found and in use', async () => {
    await expect(runtimeFailing(404).removeImage('t')).resolves.toBeUndefined()
    await expect(runtimeFailing(409).removeImage('t')).resolves.toBeUndefined()
  })

  test('rethrows anything else', async () => {
    await expect(runtimeFailing(500).removeImage('t')).rejects.toThrow('status 500')
  })
})

describe('connect', () => {
  test('does nothing when already attached, and tolerates losing a connect race', async () => {
    const connect = vi.fn(async () => {})
    const attached = fake({
      getContainer: () => ({ inspect: async () => ({ NetworkSettings: { Networks: { net1: {} } } }) }),
      getNetwork: () => ({ connect }),
    })
    await createDockerRuntime(attached).connect('c', 'net1')
    expect(connect).not.toHaveBeenCalled()

    const raced = fake({
      getContainer: () => ({ inspect: async () => ({ NetworkSettings: { Networks: {} } }) }),
      getNetwork: () => ({
        connect: async () => Promise.reject(dockerError(403, 'endpoint with name c already exists in network net1')),
      }),
    })
    await expect(createDockerRuntime(raced).connect('c', 'net1')).resolves.toBeUndefined()
  })
})

describe('attachAlias', () => {
  function networkRecording(disconnectError?: Error, connectError?: Error) {
    const calls: string[] = []
    const getNetwork = vi.fn(() => ({
      disconnect: async (o: object) => {
        calls.push(`disconnect ${JSON.stringify(o)}`)
        if (disconnectError) throw disconnectError
      },
      connect: async (o: object) => {
        calls.push(`connect ${JSON.stringify(o)}`)
        if (connectError) throw connectError
      },
    }))
    return { calls, getNetwork, runtime: createDockerRuntime(fake({ getNetwork })) }
  }

  test('reconnects the container to the network with the aliases', async () => {
    const { calls, getNetwork, runtime } = networkRecording()
    await runtime.attachAlias('vpsm-web-1', 'net1', ['web.internal'])
    expect(getNetwork).toHaveBeenCalledWith('net1')
    expect(calls).toEqual([
      'disconnect {"Container":"vpsm-web-1"}',
      'connect {"Container":"vpsm-web-1","EndpointConfig":{"Aliases":["web.internal"]}}',
    ])
  })

  test('connects a container that was not on the network yet', async () => {
    // What the daemon answers (HTTP 500) when the container is not attached to that network.
    const notConnected = dockerError(500, '(HTTP code 500) server error - container abc is not connected to network net1 ')
    const { calls, runtime } = networkRecording(notConnected)
    await runtime.attachAlias('vpsm-web-1', 'net1', ['web.internal'])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toMatch(/^connect /)
  })

  test('rethrows other disconnect failures without connecting', async () => {
    const { calls, runtime } = networkRecording(dockerError(404, 'network net1 not found'))
    await expect(runtime.attachAlias('vpsm-web-1', 'net1', ['web.internal'])).rejects.toThrow('network net1 not found')
    expect(calls).toEqual(['disconnect {"Container":"vpsm-web-1"}'])
  })

  test('rethrows a failed connect', async () => {
    const { runtime } = networkRecording(undefined, dockerError(500, 'daemon error'))
    await expect(runtime.attachAlias('vpsm-web-1', 'net1', ['web.internal'])).rejects.toThrow('daemon error')
  })
})
