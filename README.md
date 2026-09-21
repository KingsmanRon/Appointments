# ACCESS v1 build pack

Status: architecture finalised for implementation. This pack consolidates the two proposals and the review corrections. It specifies the product, database and execution boundaries. It does not claim that the application or a hosted environment already exists.

Finalised: 21 September 2026. Platform documentation was checked on 20 September 2026.

## Read in this order

1. [Architecture](docs/ARCHITECTURE.md): final platform, product and trust decisions.
2. [Database](docs/DATABASE.md): table ownership, tenant roles and transaction rules.
3. [Reference SQL](database/schema.sql): executable database definition to turn into Supabase migrations during the build.
4. [Contracts](docs/CONTRACTS.md): API, identity, execution, policy and connector behaviour.
5. [Acceptance](docs/ACCEPTANCE.md): tests that determine whether the implementation is correct.
6. [Deployment](docs/DEPLOYMENT.md): Supabase, Vercel and Railway setup and operational gates.
7. [Build plan](docs/BUILD_PLAN.md): ordered implementation milestones and completion evidence.
8. [GPT6 Astra build prompt](BUILD_PROMPT.md): give this prompt and the entire pack to the builder.
9. [Validation](docs/VALIDATION.md): checks actually completed on this pack and remaining hosted checks.
10. [Configuration templates](config/): placeholders separated by service; no credentials are included.

## Fixed platform

| Responsibility | Platform |
| --- | --- |
| Staff console | Vercel, Next.js and TypeScript |
| Core API and workflow | Railway, Node.js and Fastify |
| Durable processing | Railway worker using the same domain packages |
| External execution | Separate Railway connector service |
| Database | Supabase PostgreSQL |
| Staff authentication | Supabase Auth |
| Private documents | Supabase Storage |

The first real destination is DTM. Its actual API must be inspected and qualified; no endpoint, permission, idempotency behaviour or deployment status is assumed. A deterministic mock supports development and failure testing. Manual resolution is part of the product.

## Precedence

The documents in this pack replace the pasted proposals. Architecture and contracts define required behaviour. SQL defines the reference storage model. Acceptance defines required evidence. If a storage detail cannot support a stated invariant, correct the storage implementation and record the reason rather than weakening the invariant silently. This precedence does not authorise a redesign of the agreed product or platforms.

Application command handlers, deployment configuration, real connector adapters and release tests are builder deliverables. Applying the SQL alone does not implement the workflow or the authority boundary.

## Workspace state

The workspace initially contained an empty Git repository with no commits and no remote. Consolidation here means merging the proposals into these documents. There was no existing implementation branch to merge or deployed database to migrate.
