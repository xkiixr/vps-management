'use client'

import { useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import type { IssuedPassword } from '@/server/actions/admin'

/**
 * A generated password, shown to the admin once. It exists only in the state of the action that made it, so it is
 * gone with a reload or a new action; nothing here stores it (no storage, no URL), and "Hide" drops it from view.
 */
export function IssuedPasswordNotice({ issued, heading }: { issued: IssuedPassword; heading: string }) {
  const [hidden, setHidden] = useState<IssuedPassword | null>(null)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  // A new password (a new object) is shown even if the last one was hidden.
  if (hidden === issued) return null

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText(issued.password)
      setCopy('copied')
    } catch {
      setCopy('failed')
    }
  }

  return (
    <Alert role="status" className="gap-2">
      <AlertTitle>{heading}</AlertTitle>
      <AlertDescription>
        <p>
          Password for <span className="font-medium text-foreground">{issued.email}</span>:
        </p>
        <p className="my-2">
          <code className="rounded bg-muted px-2 py-1 font-mono text-sm break-all text-foreground select-all">{issued.password}</code>
        </p>
        <p>
          Shown only once. Copy it now and give it to them privately; it cannot be shown again, and only a new reset
          replaces it.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <Button type="button" size="sm" variant="outline" onClick={copyPassword}>
            Copy password
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setHidden(issued)}>
            Hide
          </Button>
          {copy === 'copied' && <span className="text-sm text-foreground">Copied.</span>}
          {copy === 'failed' && <span className="text-sm text-destructive">Could not copy; select the password and copy it by hand.</span>}
        </div>
      </AlertDescription>
    </Alert>
  )
}
