import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { findProjectFor, listMembers, listServices } from '@vpsm/db'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime } from '@/lib/format'
import { deleteProjectAction } from '@/server/actions/projects'
import { createServiceAction } from '@/server/actions/services'
import { webConfig } from '@/server/config'
import { getDb } from '@/server/db'
import { requireUser } from '@/server/guards'
import { maxServiceMemoryMb } from '@/server/limits'
import { DeleteProjectForm } from './delete-project-form'
import { NewServiceForm } from './new-service-form'

type Props = { params: Promise<{ project: string }> }

// Only what the address already says, so it is the same whether or not the project exists or is visible.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: (await params).project }
}

export default async function ProjectPage({ params }: Props) {
  const { project: projectName } = await params
  const user = await requireUser()
  const db = getDb()
  // A project that does not exist and one the user may not see are the same 404.
  const project = await findProjectFor(db, { id: user.id, role: user.role }, projectName)
  if (!project) notFound()
  const [members, services, maxMemoryMb] = await Promise.all([
    listMembers(db, project.id),
    listServices(db, project.id, { httpsPort: webConfig().httpsPort }),
    maxServiceMemoryMb(db),
  ])

  return (
    <div className="grid gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/" className="text-sm text-muted-foreground hover:underline">
            ← Projects
          </Link>
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          <p className="text-sm text-muted-foreground">Created {project.createdAt.toISOString().slice(0, 10)}</p>
        </div>
        <Button asChild variant="outline">
          <Link href={`/projects/${project.name}/members`}>
            Members ({members.length})
          </Link>
        </Button>
      </div>

      <section className="grid gap-3" aria-labelledby="services-heading">
        <h2 id="services-heading" className="text-lg font-semibold">
          Services
        </h2>
        <Card>
          <CardContent>
            {services.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No services yet. Create the first one below.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>URL</TableHead>
                    <TableHead>Last deploy</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {services.map(({ service, url, latest }) => (
                    <TableRow key={service.id}>
                      <TableCell>
                        <Link href={`/projects/${project.name}/services/${service.name}`} className="font-medium hover:underline">
                          {service.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={latest?.status ?? null} />
                      </TableCell>
                      <TableCell>
                        {url ? (
                          <a href={url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                            {url}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{latest ? formatDateTime(latest.createdAt) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>New service</CardTitle>
          <CardDescription>Builds the repository and deploys it as soon as the service is created.</CardDescription>
        </CardHeader>
        <CardContent>
          <NewServiceForm maxMemoryMb={maxMemoryMb} action={createServiceAction.bind(null, project.name)} />
        </CardContent>
      </Card>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Delete project</CardTitle>
          <CardDescription>
            Removes the project with its services, deployments and domains. This cannot be undone, and it is refused
            while a deployment is running.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteProjectForm projectName={project.name} action={deleteProjectAction.bind(null, project.name)} />
        </CardContent>
      </Card>
    </div>
  )
}
