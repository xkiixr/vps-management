import { expect, test } from 'vitest'
import { systemEnv } from '../src/system-env'

test('systemEnv without public hostname', () => {
  expect(systemEnv({ port: 8080, serviceName: 'api', projectName: 'shop' })).toEqual({
    PORT: '8080', APP_SERVICE_NAME: 'api', APP_PROJECT_NAME: 'shop', APP_PRIVATE_DOMAIN: 'api.internal',
  })
})
test('systemEnv with public hostname', () => {
  expect(systemEnv({ port: 3000, serviceName: 'web', projectName: 'shop', publicHostname: 'web-shop.apps.example.com' }).APP_PUBLIC_DOMAIN)
    .toBe('web-shop.apps.example.com')
})
