# The dashboard image. compose.yaml runs it as the dashboard service. Build from
# the repository root:
#
#   docker build --file apps/dashboard/Dockerfile --tag rff-dashboard:local .
#
# node:24.13.0-alpine, pinned to the digest of its multi-platform index.
ARG NODE_IMAGE=node:24.13.0-alpine@sha256:cd6fb7efa6490f039f3471a189214d5f548c11df1ff9e5b181aa49e22c14383e

# next build runs on the image's own platform: the standalone output keeps the
# platform's native packages (sharp, for image optimisation) that it traced.
FROM ${NODE_IMAGE} AS build
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/dashboard/package.json apps/dashboard/
# The workspace root brings TypeScript, which next build type-checks with.
RUN npm ci --workspace @rff/dashboard --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY apps/dashboard/next.config.ts apps/dashboard/tsconfig.json apps/dashboard/
COPY apps/dashboard/app apps/dashboard/app
COPY apps/dashboard/lib apps/dashboard/lib
RUN npm run build --workspace @rff/dashboard

# .next/standalone holds server.js and the traced node_modules; the static assets
# are copied next to it, where server.js serves them.
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3100
WORKDIR /app
# Files stay owned by root, so the process cannot change its own code.
COPY --from=build /src/apps/dashboard/.next/standalone ./
COPY --from=build /src/apps/dashboard/.next/static apps/dashboard/.next/static
# The image's "node" user, by number, so a runtime can check that it is not root.
USER 1000:1000
EXPOSE 3100
CMD ["node", "apps/dashboard/server.js"]
