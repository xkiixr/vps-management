/** A text field of a submitted form, trimmed. `undefined` when it is absent or not text (a file upload). */
export function formText(form: FormData, name: string): string | undefined {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : undefined
}
