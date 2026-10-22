import Link from 'next/link'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { logoutAction } from '@/server/actions/auth'
import { requireUser } from '@/server/guards'

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser()
  const links = [
    { href: '/', label: 'Projects' },
    ...(user.role === 'admin' ? [{ href: '/admin/users', label: 'Admin' }] : []),
    { href: '/account', label: 'Account' },
  ]
  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/" className="font-semibold">
            VPSM
          </Link>
          <nav className="flex items-center gap-4 text-sm">
            {links.map((link) => (
              <Link key={link.href} href={link.href} className="text-muted-foreground hover:text-foreground">
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">{user.name}</span>
            <form action={logoutAction}>
              <Button type="submit" variant="outline" size="sm">
                Log out
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  )
}
