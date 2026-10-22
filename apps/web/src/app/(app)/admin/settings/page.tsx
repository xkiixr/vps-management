import type { Metadata } from 'next'
import { MIN_MEMORY_MB } from '@vpsm/core'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getDb } from '@/server/db'
import { requireAdmin } from '@/server/guards'
import { effectiveResourceSettings } from '@/server/limits'
import { ResourceSettingsForm } from './resource-settings-form'

export const metadata: Metadata = { title: 'Resource settings' }

export default async function SettingsPage() {
  await requireAdmin()
  const { memoryBudgetMb, maxServiceMemoryMb } = await effectiveResourceSettings(getDb())
  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Resource settings</h1>
        <p className="text-sm text-muted-foreground">
          The memory limits for deployed apps. A change applies to the next deployment, without restarting anything.
        </p>
      </div>

      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle>Memory</CardTitle>
          <CardDescription>
            Until you save a value here, the one from the server&apos;s configuration is used and marked (default).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResourceSettingsForm
            minServiceMb={MIN_MEMORY_MB}
            current={{
              memoryBudgetMb: String(memoryBudgetMb.value),
              maxServiceMemoryMb: String(maxServiceMemoryMb.value),
              memoryBudgetIsDefault: memoryBudgetMb.isDefault,
              maxServiceMemoryIsDefault: maxServiceMemoryMb.isDefault,
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
