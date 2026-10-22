import type { ComponentProps } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type Props = Omit<ComponentProps<typeof Input>, 'id'> & {
  /** The field's name in the form; also its id, so it must be unique on the page. */
  name: string
  label: string
  /** Shown under the input until there is an error to show instead. */
  hint?: string
  error?: string
}

/** A labelled text input with its hint or, once the server has refused the value, the reason. */
export function TextField({ name, label, hint, error, ...inputProps }: Props) {
  const hintId = `${name}-hint`
  const errorId = `${name}-error`
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : hint ? hintId : undefined}
        {...inputProps}
      />
      {error ? (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-sm text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
