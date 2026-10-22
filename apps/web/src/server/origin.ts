export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export type HeaderReader = Pick<Headers, 'get'>

// The panel is same-site with the team's apps (panel.<APPS_DOMAIN>), so SameSite=Lax does not stop an app's page
// from posting to the panel with the session cookie attached. Every server action therefore starts here:
// the browser's Origin header must be exactly the panel's origin (no trailing slash, scheme and host as browsers
// send them). A missing Origin, "null" or anything else is refused.
export function assertSameOrigin(h: HeaderReader, panelOrigin: string): void {
  const origin = h.get('origin')
  if (!origin || !panelOrigin || origin !== panelOrigin) throw new ForbiddenError('cross-origin request refused')
}
