import type { Metadata } from 'next'
import { listUsers } from '@vpsm/db'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getDb } from '@/server/db'
import { requireAdmin } from '@/server/guards'
import { CreateUserForm } from './create-user-form'
import { UserActions } from './user-actions'

export const metadata: Metadata = { title: 'Users' }

const day = (date: Date) => date.toISOString().slice(0, 10)

export default async function UsersPage() {
  const admin = await requireAdmin()
  // listUsers returns SafeUser: the password hash never leaves @vpsm/db. Only plain strings and booleans reach the
  // client components below.
  const users = await listUsers(getDb())
  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">
          There is no sign-up: accounts are created here, and each gets a generated password that is shown once.
        </p>
      </div>

      <Card>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((user) => (
                <TableRow key={user.id}>
                  <TableCell>
                    <div className="font-medium">
                      {user.name}
                      {user.id === admin.id && <span className="ml-2 font-normal text-muted-foreground">(you)</span>}
                    </div>
                    <div className="text-muted-foreground">{user.email}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.role === 'admin' ? 'default' : 'secondary'}>{user.role === 'admin' ? 'Admin' : 'Member'}</Badge>
                  </TableCell>
                  <TableCell>
                    {user.disabledAt === null ? (
                      <Badge variant="outline">Active</Badge>
                    ) : (
                      <Badge variant="destructive">Disabled</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{day(user.createdAt)}</TableCell>
                  <TableCell>
                    <UserActions
                      userId={user.id}
                      email={user.email}
                      role={user.role}
                      disabled={user.disabledAt !== null}
                      isSelf={user.id === admin.id}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>New user</CardTitle>
          <CardDescription>The account gets a generated password. It is shown once, right after you create it.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateUserForm />
        </CardContent>
      </Card>
    </div>
  )
}
