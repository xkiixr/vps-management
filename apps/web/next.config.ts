import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // A self-contained server (apps/web/server.js plus only the files it needs) for the Docker image.
  output: 'standalone',
  // The workspace packages live outside apps/web, so file tracing has to start at the repository root.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // @vpsm/core and @vpsm/db export TypeScript sources.
  transpilePackages: ['@vpsm/core', '@vpsm/db'],
  // Native addon and a driver that must be required at runtime, not bundled.
  serverExternalPackages: ['@node-rs/argon2', 'postgres'],
}

export default nextConfig
