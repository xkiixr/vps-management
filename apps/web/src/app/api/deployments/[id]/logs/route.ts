import { getDb } from '@/server/db'
import { GENERIC_ERROR, logServerError } from '@/server/errors'
import { apiUser } from '@/server/guards'
import { doReadLogs } from '@/server/logs'

// The build log of a deployment as JSON, for the log page to poll: `?after=<id of the last line you have>`. A
// read, so there is no Origin check (a page of another site can send it, but cannot read the answer), and no
// answer is ever stored by a browser or a proxy.
const headers = { 'Cache-Control': 'no-store' }
const reply = (status: number, body: unknown) => Response.json(body, { status, headers })

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const user = await apiUser()
    if (!user) return reply(401, { error: 'unauthorized' })
    const { id } = await params
    const after = new URL(request.url).searchParams.get('after')
    const result = await doReadLogs(getDb(), { id: user.id, role: user.role }, id, after)
    return reply(result.status, result.body)
  } catch (error) {
    logServerError('reading deployment logs', error)
    return reply(500, { error: GENERIC_ERROR })
  }
}
