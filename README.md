# SEO Growth Engine

Multi-tenant SaaS for technical SEO audits, keyword tracking, white-hat backlink acquisition and verified reporting, for individual businesses and for agencies managing many clients.

**Status:** M0 (foundations) complete. See [docs/PROGRESS.md](docs/PROGRESS.md). Fully independent of any existing website, repository, database or hosting project. Default product name: Futuready Media (configurable).

## Documents

| Doc | Contents |
|---|---|
| [docs/PRD.md](docs/PRD.md) | Product requirements, personas, modules, non-functional requirements |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack, topology, tenancy flow, crawler, jobs, integrations |
| [docs/DATABASE_DESIGN.md](docs/DATABASE_DESIGN.md) | Tenant-aware schema, RLS policies, roles, partitioning |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, permission matrix, isolation tests, encryption, backups |
| [docs/MILESTONES.md](docs/MILESTONES.md) | Milestones, definition of done, open decisions |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Decisions, completed milestones, test evidence |

## Ground rules

- No mandatory paid APIs. Optional bring-your-own-key providers are off by default and never a silent fallback.
- Tenant isolation is enforced by PostgreSQL Row-Level Security as well as application checks.
- A backlink is counted only after it has been verified on the live page.

## Local development

Requires Node 20+, pnpm 9 and Docker.

```bash
cp .env.example .env            # also copy to apps/web/.env.local, apps/worker/.env, packages/db/.env
pnpm install
pnpm db:up                      # Postgres on :54329, Mailpit UI on :8025
pnpm db:migrate
pnpm dev                        # http://localhost:3000  (health: /api/health)
pnpm test                       # includes the tenant-isolation suite
pnpm --filter @sge/worker once  # one worker batch (what the cPanel cron runs)
```
