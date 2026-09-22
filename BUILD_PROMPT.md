# Prompt for the ACCESS v1.1 builder

Copy the text below into GPT6 Astra in the repository containing this pack. If starting in a different workspace, attach or copy the entire build pack, including database/schema.sql and the docs directory.

```text
Build ACCESS v1.1 from the approved architecture pack in this repository. I want working software, not another architecture review or a plan only response. Do not begin until the repository owner has approved the product hold point in README.md.

Read README.md, docs/WHITEPAPER_ALIGNMENT.md, docs/COMPETITIVE_ANALYSIS.md, docs/ARCHITECTURE.md, docs/DATABASE.md, database/schema.sql, docs/CONTRACTS.md, docs/ACCEPTANCE.md, docs/DEPLOYMENT.md, docs/BUILD_PLAN.md and docs/VALIDATION.md before implementing. The pack merges the original proposal and all agreed corrections. Preserve its product scope, invariants and platform decisions.

Fixed platforms:
1. Supabase PostgreSQL for the system of record, Supabase Auth for staff authentication, and private Supabase Storage for documents.
2. Vercel for the Next.js staff console.
3. Railway for the Fastify core API, persistent worker and separate connector runtime.
4. TypeScript monorepo with pnpm, explicit SQL transactions and parameterised pg queries.
5. DTM as the first real connector, a deterministic failure capable mock and a manual completion path.

Your scope is to implement the entire local application and prepare deployment configuration. Work through every milestone in docs/BUILD_PLAN.md. Use subagents for independent bounded work if available. Preserve unrelated edits. Inspect actual repository state and tooling first. Create a codex/ prefixed implementation branch where appropriate. Do not invent repository URLs or endpoints. Read available relevant skills and verify current official platform documentation before relying on APIs or configuration.

The reference SQL is supplied for implementation. It has not been applied to a hosted Supabase project. Create real Supabase migration files with the installed CLI, preserve the reference constraints and execute the migrations in an isolated development database. Use the Supabase project's actual PostgreSQL major for qualification. The reference DDL does not replace application handlers, policy logic or integration tests.

Non negotiable behaviour:
1. Treat `access_case` as the stable platform aggregate and referral as the only enabled v1.1 case type. Keep reserved channels and case types disabled until separately accepted.
2. Browser domain access goes through the Railway API. Private access/authz schemas are not exposed through Supabase Data API. Real tenant database login identities are bound to tenant scope using session_user and a protected mapping; never replace this with a writable tenant setting or routine service_role/postgres database access.
3. Validate Supabase Auth tokens and current membership. Never trust user editable metadata for roles. The connector has no database credentials. DTM secrets stay in connector runtime. Never expose privileged keys to Vercel client code.
4. Store state, evidence event and resulting outbox intent in one transaction. No foreign HTTP call occurs inside a database transaction.
5. Preserve document source and field provenance. Support bounded local PDF extraction and OCR. Confirm identity critical fields before execution. Do not send real documents to a remote model. Probabilistic identity is suggestion only; no patient merge or clinical triage.
6. Freeze the final mapped executable action and its RFC 8785 hash before approval. Each external write has its own execution ID and human approval of the exact action in v1. Mapping changes invalidate the plan. Dependent actions with unknown external references are prepared only after prerequisites resolve.
7. Implement current policy, actor, approval, executor and expiry checks plus grant consumption and authoritative execution STARTED in one short transaction under the tenant authority guard. The first successful start returns permission to dispatch once. Repeated or lost start responses do not authorise a repeat side effect. Revocation before the boundary blocks execution; after the boundary it cannot promise recall.
8. A timeout creates UNCERTAIN. Leases, elapsed time and negative searches never alone authorise retries. Safe repeat attempts require a verified destination guarantee or conclusive proof that prior attempts cannot commit, and current authorisation with a fresh attempt grant. Preserve the logical execution ID and immutable action.
9. Identity claims survive uncertain attempts. One referral must not release a patient creation reservation while another execution could still create the patient. Test concurrent referrals and external writer conflicts.
10. Persist authenticated external observations independently of referral expected_version. Deduplicate callbacks and reconcile late or contradictory results without losing the original facts. Human manual attestation is explicitly distinguished from verified automated execution.
11. A confirmed destination write is not a booking. Follow the case to an observed appointment or an evidenced enumerated closure, and report unknown/open cases separately.
12. Keep customer-owned operational access rules separate from authority policy and destination mapping. Bind the applicable versions to the case and exact action.
13. Measure observed, derived, estimated and unknown outcomes and observed, estimated and unknown effort separately. Do not invent savings, unattended completion, revenue or production readiness.

Build a usable staff console with login, case/referral list and filters, secure upload, source document review beside extracted fields, identity/completeness resolution, exact action approval, execution and interaction timeline, outcome follow-up, manual investigation/completion and measured reporting. Implement real loading, permission, empty, conflict, retry and error states. Keep implementation details out of ordinary staff flows unless staff need them to make a decision.

Qualify DTM from its real source/API. Do not assume it currently has patient/referral/document endpoints or idempotency guarantees. If a required endpoint is missing, finish all independent ACCESS work and identify the precise DTM change/access needed. Modify a separate DTM repository only when that scope has been authorised. Never bypass its API with direct database writes. A mock pass is not a real DTM integration pass.

Run the acceptance matrix using real PostgreSQL connections and runtime roles, not only mocked queries. Include concurrent transactions, revocation before/after start, duplicate/out of order callbacks, crashes after remote success, delayed commits after timeout, expired idempotency retention, tenant isolation, unsafe file handling and a browser end to end synthetic referral. Keep deterministic failure evidence. Fix failures; do not weaken assertions to make tests pass.

Continue autonomously through all work that can be completed locally. Missing Supabase/Vercel/Railway/DTM credentials block only the dependent hosted checks, not the rest of the implementation. Prepare exact configuration and ask only for concrete missing values when required. Do not ask me to reconfirm the agreed architecture. Do not stop after scaffolding, one phase, a partial UI or a mock demonstration.

Do not create paid resources, modify existing production databases, publish production deployments or process real patient data without explicit authorisation for the named environment. This instruction does authorise local implementation, isolated development tests, deployment artefact preparation and reviewable fixes. Do not push or merge to an unidentified remote.

At completion provide:
1. What works and how to run it locally.
2. Files and migrations created, with exact commit if committed.
3. Tests actually run and their results.
4. Local, staging, DTM and production status separately.
5. The exact missing configuration or access for any remaining hosted gate.
6. Deployment/runbook links and the next concrete action, without overstating readiness.

Use British English. Prefer numbered lists or tables and avoid dash punctuation in prose. After the product hold point is explicitly approved, start building.
```
