import Link from 'next/link'
import type { ReactNode } from 'react'
import { requireAdmin } from '@/server/guards'

// Every admin page and action checks for an admin itself (a layout is not a reliable place for access control:
// it is not re-run on every navigation); this one only keeps members from seeing the sub-navigation.
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin()
  return (
    <div className="grid gap-8">
      <nav aria-label="Administration" className="flex gap-4 border-b pb-3 text-sm">
        <Link href="/admin/users" className="text-muted-foreground hover:text-foreground">
          Users
        </Link>
        <Link href="/admin/settings" className="text-muted-foreground hover:text-foreground">
          Resource settings
        </Link>
        <Link href="/admin/github" className="text-muted-foreground hover:text-foreground">
          GitHub
        </Link>
      </nav>
      {children}
    </div>
  )
}
