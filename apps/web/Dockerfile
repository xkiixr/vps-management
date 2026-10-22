# Build context is the repository root:  docker build -f apps/web/Dockerfile .

# ---- build: compile the dashboard into a self-contained Next.js standalone server ----
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1

# Manifests first so the dependency layer is cached until a package.json or the lockfile changes. The worker's
# manifest is part of the workspace the lockfile describes, though nothing of it is installed or built here.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --filter @vpsm/web...

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
# `build` runs `next build` and copies .next/static into the standalone output. `public` is optional in a Next
# app, so make sure the directory exists for the COPY below.
RUN pnpm --filter @vpsm/web build && mkdir -p apps/web/public

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

WORKDIR /app
# The standalone output holds server.js (at apps/web/server.js, because file tracing starts at the repository
# root), the minimal node_modules it needs and the static files. The user "node" (uid 1000) owns it, so the
# server can write its cache under .next.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

# Next loads the native password hashing addon and the database driver at runtime instead of bundling them, under
# hashed names that .next/node_modules links to the copies in node_modules/.pnpm. This fails the build when file
# tracing left either out, or left out the addon's build for this image's platform (glibc). A build on the
# developer's machine would not show that: there the packages are found in the source tree around the output.
# They are imported (not required) as the server does: the driver's ESM files are the ones that were traced.
RUN cd apps/web/.next && node --input-type=module -e " \
  import fs from 'node:fs'; \
  const names = fs.readdirSync('node_modules').flatMap((n) => (n.startsWith('@') ? fs.readdirSync('node_modules/' + n).map((m) => n + '/' + m) : [n])); \
  for (const need of ['argon2', 'postgres']) { \
    const found = names.filter((n) => n.includes(need)); \
    if (found.length === 0) throw new Error('standalone output lacks ' + need); \
    for (const n of found) await import(n); \
  }"

# No docker socket, no root: the dashboard only talks to the database and answers Traefik.
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
