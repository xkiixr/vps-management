import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { DEPLOYMENT_STATUSES } from '@vpsm/core'
import { StatusBadge } from '@/components/status-badge'

const render = (status: Parameters<typeof StatusBadge>[0]['status']) => renderToStaticMarkup(createElement(StatusBadge, { status }))
const classesOf = (html: string) => /class="([^"]*)"/.exec(html)?.[1] ?? ''
// The class that sets the badge's own background (not a hover or dark-mode one).
const backgroundOf = (status: (typeof DEPLOYMENT_STATUSES)[number]) =>
  classesOf(render(status))
    .split(/\s+/)
    .find((name) => name.startsWith('bg-'))

describe('StatusBadge', () => {
  test.each(DEPLOYMENT_STATUSES)('%s has a label of its own', (status) => {
    const label = status.charAt(0) + status.slice(1).toLowerCase()
    expect(render(status)).toContain(`>${label}</span>`)
  })

  test('every status has a background colour of its own, so that no two look alike', () => {
    const backgrounds = DEPLOYMENT_STATUSES.map(backgroundOf)
    expect(backgrounds.every((background) => background !== undefined)).toBe(true)
    expect(new Set(backgrounds).size).toBe(DEPLOYMENT_STATUSES.length)
  })

  test('says "Not deployed" when there is no status', () => {
    expect(render(null)).toContain('>Not deployed</span>')
  })
})
