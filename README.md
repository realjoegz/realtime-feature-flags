# realtime-feature-flags

[![CI](https://github.com/realjoegz/realtime-feature-flags/actions/workflows/ci.yml/badge.svg)](https://github.com/realjoegz/realtime-feature-flags/actions/workflows/ci.yml)

realtime-feature-flags is a multi-tenant feature flag service in TypeScript, planned as a NestJS API on PostgreSQL and Redis, an SDK that receives flag changes over server-sent events and evaluates flags locally, and a Next.js dashboard. Each claim in [docs/evidence.md](docs/evidence.md) links the tests that check it, and the build fails unless those tests ran and passed.

Work in progress: so far the flag evaluation core in `packages/core`, the SDK client in `packages/sdk`, the API in `apps/api` and the dashboard in `apps/dashboard` exist, with sign-in through Dex, roles, flags, evaluation, the audit log, SDK keys, the SDK stream across replicas, through Redis notifications, a safety poll and a snapshot cache, and the export and deletion of a user's personal data, on tenant tables under row-level security. `docker compose up` starts the whole stack with demo data, `scripts/demo.sh` checks it, and `tools/latency` times saves on it to the last of many SDK clients across both replicas.

## Latency

<!-- latency:start -->
| Run (UTC) | Clients | Changes | To the last client (ms): min, median, p95, max | Save round trip (ms): min, median, p95, max | Reconnects | Not by notification |
| --- | --- | --- | --- | --- | --- | --- |
| [2026-10-14 17:02:35](bench/results/latency-20261014T170235Z.json) | 100: 50 on api-1, 50 on api-2 | 300 after 30 warm-up | 4.0, 5.0, 7.0, 12.9 | 1.7, 2.1, 3.3, 7.8 | 0 | 0 |
| [2026-10-14 17:05:00](bench/results/latency-20261014T170500Z.json) | 100: 50 on api-1, 50 on api-2 | 300 after 30 warm-up | 4.0, 5.0, 8.2, 17.2 | 1.6, 2.1, 4.1, 12.8 | 0 | 0 |

Conditions: MacBook Air (Mac16,12), Apple M4, 10 cores, 16 GiB, macOS 26.6.2; Colima 0.10.3 with 6 CPUs, 8 GiB, aarch64; Node 24.13.0, PostgreSQL 18.6, Redis 8.10.2, Docker 29.5.2; open-file limit 61440 in the measuring process; 1 tenant with 3 flags and a 519-byte snapshot; clients in the Node process on the host that sends the saves, each connected directly to its replica's published port; every save a PUT of dark-mode to api-1; safety poll every 30 s; commit f64f196. Reconnects and deliveries that no Redis notification brought are counted over the measured changes.
<!-- latency:end -->
