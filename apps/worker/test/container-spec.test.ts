import { DEFAULT_DEPLOY_CONFIG } from '@vpsm/core'
import { describe, expect, test } from 'vitest'
import { buildContainerSpec } from '../src/runtime/container-spec'

const input = {
  name: 'vpsm-web-12345678',
  image: 'vpsm/si:d',
  env: { PORT: '8080' },
  deploy: DEFAULT_DEPLOY_CONFIG,
  networkName: 'vpsm-env-e1',
  aliases: ['web.internal'],
  deploymentId: 'd1',
  serviceInstanceId: 'si1',
}
const spec = buildContainerSpec(input)

describe('buildContainerSpec', () => {
  test('names the container and uses the image', () => {
    expect(spec.name).toBe('vpsm-web-12345678')
    expect(spec.Image).toBe('vpsm/si:d')
  })

  test('enforces resource limits', () => {
    expect(spec.HostConfig).toMatchObject({
      Memory: 512 * 1024 * 1024,
      MemorySwap: 512 * 1024 * 1024,
      NanoCpus: 1e9,
      PidsLimit: 512,
    })
  })

  test('scales limits from the deploy config', () => {
    const big = buildContainerSpec({ ...input, deploy: { ...DEFAULT_DEPLOY_CONFIG, memoryLimitMB: 2048, cpuLimit: 0.5 } })
    expect(big.HostConfig).toMatchObject({ Memory: 2048 * 1024 * 1024, MemorySwap: 2048 * 1024 * 1024, NanoCpus: 5e8 })
    expect(big.Labels!['vpsm.memory-mb']).toBe('2048')
  })

  test('enforces security baseline', () => {
    expect(spec.HostConfig!.Privileged).toBe(false)
    expect(spec.HostConfig!.SecurityOpt).toContain('no-new-privileges:true')
    expect(spec.HostConfig!.CapDrop).toEqual(['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP', 'SETPCAP', 'SYS_CHROOT'])
    expect(spec.HostConfig!.Binds).toBeUndefined()
    expect(spec.HostConfig!.PortBindings).toBeUndefined()
  })

  test('maps restart policy and log rotation', () => {
    expect(spec.HostConfig!.RestartPolicy).toEqual({ Name: 'on-failure', MaximumRetryCount: 10 })
    expect(spec.HostConfig!.LogConfig).toEqual({ Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } })
    expect(buildContainerSpec({ ...input, deploy: { ...DEFAULT_DEPLOY_CONFIG, restartPolicy: 'always' } }).HostConfig!.RestartPolicy).toEqual({
      Name: 'unless-stopped',
    })
    expect(buildContainerSpec({ ...input, deploy: { ...DEFAULT_DEPLOY_CONFIG, restartPolicy: 'never' } }).HostConfig!.RestartPolicy).toEqual({
      Name: 'no',
    })
  })

  test('labels, env, network alias', () => {
    expect(spec.Labels).toEqual({
      'vpsm.managed': 'true',
      'vpsm.deployment-id': 'd1',
      'vpsm.service-instance-id': 'si1',
      'vpsm.memory-mb': '512',
    })
    expect(spec.Env).toEqual(['PORT=8080'])
    expect(spec.NetworkingConfig!.EndpointsConfig!['vpsm-env-e1'].Aliases).toEqual(['web.internal'])
    expect(spec.HostConfig!.NetworkMode).toBe('vpsm-env-e1')
  })

  test('env is KEY=VALUE sorted by key and values keep their "="', () => {
    const s = buildContainerSpec({ ...input, env: { ZED: '1', ALPHA: 'a=b', MID: '' } })
    expect(s.Env).toEqual(['ALPHA=a=b', 'MID=', 'ZED=1'])
  })

  test('Cmd is set only when a command is given', () => {
    expect(spec.Cmd).toBeUndefined()
    expect(buildContainerSpec({ ...input, cmd: ['node', 'server.js'] }).Cmd).toEqual(['node', 'server.js'])
  })
})
