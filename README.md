# realtime-feature-flags

[![CI](https://github.com/realjoegz/realtime-feature-flags/actions/workflows/ci.yml/badge.svg)](https://github.com/realjoegz/realtime-feature-flags/actions/workflows/ci.yml)

realtime-feature-flags is a multi-tenant feature flag service in TypeScript, planned as a NestJS API on PostgreSQL and Redis, an SDK that receives flag changes over server-sent events and evaluates flags locally, and a Next.js dashboard. Each claim in [docs/evidence.md](docs/evidence.md) links the tests that check it, and the build fails unless those tests ran and passed.

Work in progress: so far the flag evaluation core in `packages/core`, the SDK client in `packages/sdk` and the API in `apps/api` exist, with sign-in by bearer token, roles, flags, evaluation, the audit log, SDK keys, the SDK stream across replicas, through Redis notifications, a safety poll and a snapshot cache, and the export and deletion of a user's personal data, on tenant tables under row-level security.
