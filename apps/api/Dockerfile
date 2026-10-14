# The API image. compose.yaml runs it as the two API replicas and, with another
# command, as the one-shot migrate service. Build from the repository root:
#
#   docker build --file apps/api/Dockerfile --tag rff-api:local .
#
# node:24.13.0-alpine, pinned to the digest of its multi-platform index.
ARG NODE_IMAGE=node:24.13.0-alpine@sha256:cd6fb7efa6490f039f3471a189214d5f548c11df1ff9e5b181aa49e22c14383e

# Compiles TypeScript on the build machine's own platform: tsc output is plain
# JavaScript, so a build for another platform needs no emulation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @rff/api --include-workspace-root --ignore-scripts --no-audit --no-fund
# @rff/core first: the API imports it, and tsc reads its declarations from its dist.
COPY packages/core/tsconfig.json packages/core/tsconfig.build.json packages/core/
COPY packages/core/src packages/core/src
RUN npm run build --workspace @rff/core
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN npm run build --workspace @rff/api

# The runtime dependencies (Nest, Express, pg, rxjs, jose, redis) are JavaScript with
# no native addons, so they install on the build platform as well. npm links the
# workspace package @rff/core into node_modules as ../../packages/core.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS runtime-deps
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
RUN npm ci --workspace @rff/api --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
# Files stay owned by root, so the process cannot change its own code.
COPY --from=runtime-deps /src/node_modules node_modules
# The target of the node_modules/@rff/core link. The API imports it when it starts,
# so an image without it does not start and fails the compose healthcheck.
COPY packages/core/package.json packages/core/
COPY --from=build /src/packages/core/dist packages/core/dist
COPY apps/api/package.json apps/api/
COPY apps/api/migrations apps/api/migrations
COPY --from=build /src/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
# The image's "node" user, by number, so a runtime can check that it is not root.
USER 1000:1000
EXPOSE 4000
CMD ["node", "dist/main.js"]
