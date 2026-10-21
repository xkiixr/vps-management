const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/** A duration for a failure message: `10 minutes`, `1 minute`, `30 seconds`, or `1500 ms` when not a whole second. */
export function describeDuration(ms: number): string {
  if (ms % 60_000 === 0) return plural(ms / 60_000, 'minute')
  if (ms % 1000 === 0) return plural(ms / 1000, 'second')
  return `${ms} ms`
}
