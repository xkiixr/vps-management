import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { findProjectFor, listMembers } from '@vpsm/db'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getDb } from '@/server/db'
import { requireUser } from '@/server/guards'
import { DeleteProjectForm } from './delete-project-form'

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
  const members = await listMembers(db, project.id)

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
            <p className="py-6 text-center text-sm text-muted-foreground">No services yet.</p>
          </CardContent>
        </Card>
      </section>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Delete project</CardTitle>
          <CardDescription>
            Removes the project with its services, deployments and domains. This cannot be undone, and it is refused
            while a deployment is running.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DeleteProjectForm projectName={project.name} />
        </CardContent>
      </Card>
    </div>
  )
}
