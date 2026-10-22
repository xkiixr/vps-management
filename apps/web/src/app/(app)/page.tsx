import type { Metadata } from 'next'
import Link from 'next/link'
import { listProjectsFor } from '@vpsm/db'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getDb } from '@/server/db'
import { requireUser } from '@/server/guards'
import { CreateProjectForm } from './create-project-form'

export const metadata: Metadata = { title: 'Projects' }

const day = (date: Date) => date.toISOString().slice(0, 10)

export default async function ProjectsPage() {
  const user = await requireUser()
  // Admins get every project, members the ones they belong to.
  const projects = await listProjectsFor(getDb(), { id: user.id, role: user.role })
  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Projects</h1>
        <p className="text-sm text-muted-foreground">
          {user.role === 'admin' ? 'Every project on this server.' : 'The projects you are a member of.'}
        </p>
      </div>

      <Card>
        <CardContent>
          {projects.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No projects yet. Create the first one below.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Services</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map(({ project, serviceCount }) => (
                  <TableRow key={project.id}>
                    <TableCell>
                      <Link href={`/projects/${project.name}`} className="font-medium hover:underline">
                        {project.name}
                      </Link>
                    </TableCell>
                    <TableCell>{serviceCount}</TableCell>
                    <TableCell className="text-muted-foreground">{day(project.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>New project</CardTitle>
          <CardDescription>You become its first member and can invite the rest of the team.</CardDescription>
        </CardHeader>
        <CardContent>
          <CreateProjectForm />
        </CardContent>
      </Card>
    </div>
  )
}
