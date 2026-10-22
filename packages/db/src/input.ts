// Checks for values that come from users (URLs, forms) before they reach a query. Internal to this package.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// C0 control characters and DEL. NUL in particular makes Postgres reject the whole statement.
export const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

// Comparing a uuid column with a string that is not a uuid is a Postgres error, not "no rows".
export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

// Emails are stored lowercase (see the users table), so every lookup normalises the same way.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
