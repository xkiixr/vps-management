/** "/app" and "./app" are common ways to write a path relative to the repository root. */
export const stripLeadingRoot = (dir: string) => dir.replace(/^(?:\.?\/+)+/, '')
