# ACCESS v1.1 patient-access build pack

Status: review candidate before application implementation. This pack defines ACCESS Referral Operations as a standalone patient-access orchestration product. It specifies the market problem, product boundary, database and execution contracts. It does not claim that the application, connector or hosted environment already exists.

Revised: 22 September 2026. The revision aligns the product with the patient-access transformation thesis and adds closed-loop outcomes, generic cases, operational rules and competitive positioning.

## Read in this order

1. [Whitepaper alignment](docs/WHITEPAPER_ALIGNMENT.md): BCG thesis, buyer, product scope, pilot and funding proof sequence.
2. [Competitive analysis](docs/COMPETITIVE_ANALYSIS.md): closest global and South African products, defensible wedge and discovery tests.
3. [Architecture](docs/ARCHITECTURE.md): platform, product and trust decisions.
4. [Database](docs/DATABASE.md): table ownership, tenant roles and transaction rules.
5. [Reference SQL](database/schema.sql): executable database definition to turn into Supabase migrations during the build.
6. [Contracts](docs/CONTRACTS.md): case, referral, API, identity, execution, outcome, policy and connector behaviour.
7. [Acceptance](docs/ACCEPTANCE.md): tests that determine whether the implementation is correct.
8. [Deployment](docs/DEPLOYMENT.md): Supabase, Vercel and Railway setup and operational gates.
9. [Build plan](docs/BUILD_PLAN.md): ordered implementation milestones and completion evidence.
10. [GPT6 Astra build prompt](BUILD_PROMPT.md): give this prompt and the entire pack to the builder.
11. [Validation](docs/VALIDATION.md): checks actually completed on this pack and remaining hosted checks.
12. [Configuration templates](config/): placeholders separated by service; no credentials are included.

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

The first enabled case type is referral. The first real destination is DTM. Its actual API must be inspected and qualified; no endpoint, permission, idempotency behaviour or deployment status is assumed. A deterministic mock supports development and failure testing. Manual resolution is part of the product. A destination commit does not count as a booking; the case remains open until a booking or supported closure is evidenced.

## Precedence

The documents in this pack replace the pasted proposals. Architecture and contracts define required behaviour. SQL defines the reference storage model. Acceptance defines required evidence. If a storage detail cannot support a stated invariant, correct the storage implementation and record the reason rather than weakening the invariant silently. This precedence does not authorise a redesign of the agreed product or platforms.

Application command handlers, deployment configuration, real connector adapters and release tests are builder deliverables. Applying the SQL alone does not implement the workflow or the authority boundary.

## Implementation hold point

Review and approve the product thesis, first design-partner profile, pilot outcome contract, case/outcome model and competitive wedge before starting the application build. The existing GitHub `main` branch contains only the initial README/licence commit; this pack lives on an architecture branch and is not a runnable application.
