import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { configChangedSinceLiveDeploy, findProjectFor, findService } from '@vpsm/db'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime } from '@/lib/format'
import { webConfig } from '@/server/config'
import { getDb } from '@/server/db'
import { requireUser } from '@/server/guards'
import { maxServiceMemoryMb } from '@/server/limits'
import { DeleteServiceForm } from './delete-service-form'
import { type ServiceSettings, SettingsForm } from './settings-form'

type Props = { params: Promise<{ project: string; service: string }> }

// Only what the address already says, so it is the same whether or not the service exists or is visible.
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { project, service } = await params
  return { title: `${service} · ${project}` }
}

export default async function ServicePage({ params }: Props) {
  const { project: projectName, service: serviceName } = await params
  const user = await requireUser()
  const db = getDb()
  const { httpsPort } = webConfig()
  // A project or service that does not exist and one the user may not see are the same 404.
  const project = await findProjectFor(db, { id: user.id, role: user.role }, projectName)
  if (!project) notFound()
  const row = await findService(db, project.id, serviceName, { httpsPort })
  if (!row) notFound()
  const maxMemoryMb = await maxServiceMemoryMb(db)

  const { service, instance, url, latest } = row
  // Only these settings go to the browser, as text for the form.
  const settings: ServiceSettings = {
    repo: instance.source?.repo ?? '',
    branch: instance.source?.branch ?? '',
    rootDirectory: instance.source?.rootDirectory ?? '',
    healthcheckPath: instance.deploy.healthcheckPath ?? '',
    port: String(instance.deploy.port),
    memoryLimitMB: String(instance.deploy.memoryLimitMB),
    startCommand: instance.deploy.startCommand ?? '',
  }

  return (
    <div className="grid gap-6">
      <div>
        <Link href={`/projects/${project.name}`} className="text-sm text-muted-foreground hover:underline">
          ← {project.name}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{service.name}</h1>
          <StatusBadge status={latest?.status ?? null} />
        </div>
        <p className="flex flex-wrap gap-x-4 text-sm text-muted-foreground">
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {url}
            </a>
          )}
          {instance.source && (
            <span>
              {instance.source.repo} @ {instance.source.branch}
            </span>
          )}
          <span>{latest ? `Last deploy ${formatDateTime(latest.createdAt)}` : 'Not deployed yet'}</span>
        </p>
      </div>

      {configChangedSinceLiveDeploy(row) && (
        <Alert>
          <AlertTitle>Settings changed since the last deploy</AlertTitle>
          <AlertDescription>
            The running deployment still uses the previous settings. The next push or deploy will use the new ones.
          </AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="deployments">
        <TabsList>
          <TabsTrigger value="deployments">Deployments</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="danger">Danger zone</TabsTrigger>
        </TabsList>

        <TabsContent value="deployments" className="mt-4">
          <Card>
            <CardContent>
              <p className="py-6 text-center text-sm text-muted-foreground">The deployment history and logs will show here.</p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="settings" className="mt-4">
          <Card className="max-w-3xl">
            <CardHeader>
              <CardTitle>Settings</CardTitle>
              <CardDescription>
                Saving deploys the service again with the new settings, unless you save without deploying.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SettingsForm projectName={project.name} serviceName={service.name} current={settings} maxMemoryMb={maxMemoryMb} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="danger" className="mt-4">
          <Card className="max-w-lg">
            <CardHeader>
              <CardTitle>Delete service</CardTitle>
              <CardDescription>
                Removes the service with its deployments and domains, and then its containers and images. This cannot be
                undone, and it is refused while a deployment is running.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <DeleteServiceForm projectName={project.name} serviceName={service.name} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
