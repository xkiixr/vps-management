/** Problems with single form fields, keyed by the field's name. */
export type FieldErrors = Partial<Record<string, string>>

/**
 * What a server action used with `useActionState` hands back to its form when it did not redirect.
 * - `error`: a problem with the whole request, shown above the form.
 * - `fieldErrors`: problems with single fields, shown next to them.
 * - `notice`: what happened, when it went through and the page stays.
 * - `values`: the text that was submitted, for a form with many fields to show again: React empties a form once
 *   its action is done, so without this a mistake in one field would wipe all the others.
 */
export type ActionState = { error?: string; fieldErrors?: FieldErrors; notice?: string; values?: Record<string, string> }
