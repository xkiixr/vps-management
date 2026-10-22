const UNIQUE_VIOLATION = '23505'

export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}

// Drizzle wraps the driver error; the postgres.js error (with `code` and `constraint_name`) is on `cause`.
export function violatedUniqueConstraint(error: unknown): string | undefined {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const { code, constraint_name } = e as { code?: unknown; constraint_name?: unknown }
    if (code === UNIQUE_VIOLATION && typeof constraint_name === 'string') return constraint_name
  }
  return undefined
}
