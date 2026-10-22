import { createDb, type Db } from '@vpsm/db'
import { webConfig } from './config'

const DB_KEY = Symbol.for('vpsm.web.db')

// One connection pool per process, created on first use (never at build time). Kept on globalThis so that the
// separately bundled proxy and a dev server reloading modules do not each open another pool.
export function getDb(): Db {
  const holder = globalThis as { [DB_KEY]?: Db }
  return (holder[DB_KEY] ??= createDb(webConfig().databaseUrl).db)
}
