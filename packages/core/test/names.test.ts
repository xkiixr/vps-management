import { expect, test } from 'vitest'
import {
  containerName,
  generatedHostname,
  imageTag,
  isValidHostname,
  networkName,
  privateHostname,
  publicUrl,
  validateName,
} from '../src/names'

test('validateName accepts lowercase names', () => {
  expect(validateName('web')).toEqual({ ok: true })
  expect(validateName('api-v2')).toEqual({ ok: true })
})
test.each(['Web', 'เว็บ', 'my app', 'web-', '-web', '1web', 'a'.repeat(31), ''])('validateName rejects %j', (n) => {
  expect(validateName(n).ok).toBe(false)
})
test('generatedHostname joins service and project', () => {
  expect(generatedHostname('web', 'shop', 'apps.example.com')).toBe('web-shop.apps.example.com')
})
test('longest valid names still make a valid DNS label', () => {
  const h = generatedHostname('a'.repeat(30), 'b'.repeat(30), 'apps.example.com')
  expect(isValidHostname(h)).toBe(true)
})
test('isValidHostname rejects rule-breaking input', () => {
  expect(isValidHostname('a`) || Host(`evil.com')).toBe(false)
  expect(isValidHostname('UPPER.example.com')).toBe(false)
})
test('docker names use vpsm prefix', () => {
  expect(containerName('web', '1234567890ab')).toBe('vpsm-web-12345678')
  expect(networkName('env1')).toBe('vpsm-env-env1')
  expect(imageTag('si1', 'd1')).toBe('vpsm/si1:d1')
  expect(privateHostname('api')).toBe('api.internal')
})
test('publicUrl omits the port 443 and keeps any other port', () => {
  expect(publicUrl('web-shop.apps.example.com', 443)).toBe('https://web-shop.apps.example.com')
  expect(publicUrl('web-shop.apps.example.com', 8443)).toBe('https://web-shop.apps.example.com:8443')
  expect(publicUrl('web-shop.apps.example.com', 1)).toBe('https://web-shop.apps.example.com:1')
})
