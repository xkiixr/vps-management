/** A text field of a submitted form, trimmed. `undefined` when it is absent or not text (a file upload). */
export function formText(form: FormData, name: string): string | undefined {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : undefined
}

/** A text field of a submitted form exactly as typed (a password may start or end with spaces). */
export function formRawText(form: FormData, name: string): string | undefined {
  const value = form.get(name)
  return typeof value === 'string' ? value : undefined
}

/** The named text fields of a submitted form, trimmed. A field that is absent or not text is left out. */
export function formTexts(form: FormData, names: readonly string[]): Record<string, string> {
  const texts: Record<string, string> = {}
  for (const name of names) {
    const text = formText(form, name)
    if (text !== undefined) texts[name] = text
  }
  return texts
}

// C0 control characters and DEL: a NUL makes Postgres refuse the whole statement, and a line break has no place
// in a name, a branch, a path or a command that is run as one line. Same set as @vpsm/db checks.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

export function hasControlCharacters(text: string): boolean {
  return CONTROL_CHARACTERS.test(text)
}
