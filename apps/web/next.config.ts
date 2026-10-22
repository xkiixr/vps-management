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
  // The panel is same-site with the team's apps, so any of them could frame it, and a click inside the frame would
  // carry the panel's own Origin and its SameSite=Lax cookie past every check of a server action. No page of the
  // panel may be framed by anyone (X-Frame-Options for older browsers, frame-ancestors for the rest).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ]
  },
}

export default nextConfig
