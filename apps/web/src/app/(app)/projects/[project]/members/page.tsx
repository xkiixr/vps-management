import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { findProjectFor, listMembers } from '@vpsm/db'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { addMemberAction, removeMemberAction } from '@/server/actions/projects'
import { getDb } from '@/server/db'
import { requireUser } from '@/server/guards'
import { AddMemberForm } from './add-member-form'
import { RemoveMemberForm } from './remove-member-form'

type Props = { params: Promise<{ project: string }> }

// Only what the address already says, so it is the same whether or not the project exists or is visible.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: `Members · ${(await params).project}` }
}

export default async function MembersPage({ params }: Props) {
  const { project: projectName } = await params
  const user = await requireUser()
  const db = getDb()
  // A project that does not exist and one the user may not see are the same 404.
  const project = await findProjectFor(db, { id: user.id, role: user.role }, projectName)
  if (!project) notFound()
  const members = await listMembers(db, project.id)

  return (
    <div className="grid gap-8">
      <div>
        <Link href={`/projects/${project.name}`} className="text-sm text-muted-foreground hover:underline">
          ← {project.name}
        </Link>
        <h1 className="text-2xl font-semibold">Members</h1>
        <p className="text-sm text-muted-foreground">
          Every member can deploy, change settings and invite or remove other members.
        </p>
      </div>

      <Card>
        <CardContent>
          {members.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              This project has no members, so only admins can see it. Add someone below.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead className="w-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map(({ user: member, addedAt }) => (
                  <TableRow key={member.id}>
                    <TableCell className="font-medium">
                      {member.name}
                      {member.id === user.id && <span className="ml-2 font-normal text-muted-foreground">(you)</span>}
                    </TableCell>
                    <TableCell>{member.email}</TableCell>
                    <TableCell className="text-muted-foreground">{addedAt.toISOString().slice(0, 10)}</TableCell>
                    <TableCell>
                      <RemoveMemberForm label={member.email} action={removeMemberAction.bind(null, project.name, member.id)} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Add a member</CardTitle>
          <CardDescription>The person needs an account already; an administrator creates accounts.</CardDescription>
        </CardHeader>
        <CardContent>
          <AddMemberForm action={addMemberAction.bind(null, project.name)} />
        </CardContent>
      </Card>
    </div>
  )
}
