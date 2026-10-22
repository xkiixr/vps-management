# Build context is the repository root:  docker build -f apps/worker/Dockerfile .

# ---- build: compile the worker and collect its production dependencies ----
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo

# Manifests first so the dependency layer is cached until a package.json or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm --filter @vpsm/worker build
RUN pnpm deploy --filter @vpsm/worker --prod /out

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime

# BuildKit sets TARGETARCH (amd64 or arm64) for the platform being built.
ARG TARGETARCH
# Keep in step with RAILPACK_FRONTEND_IMAGE in apps/worker/src/config.ts.
ARG RAILPACK_VERSION=0.43.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# Docker CLI and buildx plugin only; the daemon is the host's, reached through the mounted socket.
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:29-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

RUN case "${TARGETARCH}" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=arm64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/railwayapp/railpack/releases/download/v${RAILPACK_VERSION}/railpack-v${RAILPACK_VERSION}-${arch}-unknown-linux-musl.tar.gz" \
    | tar -xz -C /usr/local/bin railpack
# Fails the build when the asset is missing, truncated or for the wrong architecture.
RUN railpack --version

WORKDIR /app
# /out also holds a copy of the worker's sources; only the production node_modules and package.json
# ("type": "module") are needed next to the bundled dist.
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
COPY --from=build /repo/packages/db/migrations ./migrations
ENV MIGRATIONS_DIR=/app/migrations

# Runs as root on purpose: the worker needs the Docker socket, which makes it root-equivalent on the host.
CMD ["node", "dist/main.js"]
