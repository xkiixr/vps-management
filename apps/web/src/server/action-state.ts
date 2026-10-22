/** Problems with single form fields, keyed by the field's name. */
export type FieldErrors = Partial<Record<string, string>>

/** What a server action used with `useActionState` hands back to its form when it did not redirect. */
export type ActionState = { error?: string; fieldErrors?: FieldErrors }
