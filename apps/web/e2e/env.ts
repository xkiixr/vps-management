/** The dashboard under test listens here, and this is the `Origin` its server actions accept (PANEL_ORIGIN). */
export const E2E_PORT = 3100
export const E2E_ORIGIN = `http://localhost:${E2E_PORT}`

/** Set by global-setup for the test workers (which start after it) to read. */
export const ADMIN_EMAIL = 'admin@example.com'
export const TEAMMATE_EMAIL = 'teammate@example.com'
export const ADMIN_PASSWORD_VAR = 'E2E_ADMIN_PASSWORD'
