/** `2026-10-22 17:09 UTC`: the same text on the server and in the browser, whatever either one's time zone. */
export function formatDateTime(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}
