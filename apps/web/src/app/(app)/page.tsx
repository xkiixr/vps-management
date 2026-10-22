import { requireUser } from '@/server/guards'

// Placeholder until the project list (Task 7).
export default async function ProjectsPage() {
  await requireUser()
  return <h1 className="text-2xl font-semibold">Projects</h1>
}
