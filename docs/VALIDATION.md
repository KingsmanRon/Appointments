# ACCESS v1.1 build pack validation

Revised on 22 September 2026.

## Current v1.1 checks

1. PostgreSQL syntax parsing completed for all 108 statements in `database/schema.sql` using pglast 7.10. The current schema digest is `3ddc5861c9fafd552fc9f608d70a9a854968dc249f633bb86243cbdfa2af986e`.
2. The reference contains 46 `access` domain tables. The schema's provisioning loop applies ENABLE and FORCE RLS plus tenant policy to every table in that schema.
3. `database/validate_reference.py` compiles under Python 3.12 and now creates cases, rules, interactions and booking outcomes in addition to the previous fixtures.
4. Documentation consistency and Git whitespace checks completed locally.

A real PostgreSQL server is not installed in the current review workspace. Therefore the v1.1 DDL execution and smoke suite are **NOT_RUN**, not passed. Syntax parsing cannot establish foreign-key validity, trigger behaviour, privileges, RLS isolation or transaction semantics.

## Prior v1 evidence, retained but superseded

The pre-v1.1 schema was applied to an empty local PostgreSQL 18.1 database and its 42 domain tables passed the supplied 37-check smoke suite. `database/validation_v1_result.json` records schema digest `5697cf24fcf91308033686725497d101960760d7d9c357ebc862e90db0cb747a`. It does not match the current v1.1 schema and must not be cited as current validation. A new `database/validation_result.json` will be created only when the updated harness is run.

The smoke checks cover tenant visibility, unregistered identity denial, resistance to a forged tenant setting, denied role switching and principal map access, cross tenant writes and references, worker permissions, authority guard locking, immutable execution bodies and approvals, command receipt immutability, valid state names, upload jobs before referral creation, recovery lane constraints, grant to attempt binding, atomic rollback, irreversible consumption, one STARTED attempt, immutable manual plans, unknown effort, session revocation records and accepted artefact scan/immutability checks.

## Earlier corrected findings and retained evidence

The initial smoke run passed 32 checks and failed one because its session revocation fixture omitted the required reason_code. The test fixture was corrected; the original result remains in database/validation_initial_result.json. It is not represented as a passing run.

The final consistency pass corrected these design defects before validation:

1. Upload verification can be queued without an existing referral.
2. Manual prepared actions and human attestations have immutable storage.
3. Grant consumption references the exact grant that created an attempt.
4. Accepted artefacts require an explicit CLEAN scan result; SQL NULL cannot satisfy acceptance accidentally.
5. Quarantine and accepted objects have separate bucket/path metadata.
6. Referral states, tenant event sequencing, source verification, identity claims, session revocation and execution body storage match the contracts.
7. Recovery jobs are independent of the write ordering barrier so uncertainty does not block its own reconciliation.

## Reproduce

Start a disposable local PostgreSQL instance and create an empty database whose name starts with access_. Apply schema.sql using a provisioning role, then run:

```powershell
psql -h 127.0.0.1 -p <port> -U <provisioner> -d <empty_database> -X -v ON_ERROR_STOP=1 -f database/schema.sql
python database/validate_reference.py --port <port> --database <empty_database> --user <provisioner>
```

The harness uses only localhost, creates synthetic fixtures and real test LOGIN roles, and writes a result report. Use a disposable test cluster with suitable local authentication. It does not install PostgreSQL, create Supabase resources or run against a hosted endpoint. Its fixture payload hashes test storage shape and immutability; they are not application JCS conformance evidence.

## Not claimed

The pack is a review candidate at the product hold point. The application has not been built. Its API handlers, atomic authorise_and_start implementation, frontend, OCR/scanner integration, workers and connector adapters remain builder deliverables.

No hosted Supabase schema was applied. Supabase role provisioning, session pooler identity behaviour, Auth and Storage must be verified on the selected project's actual PostgreSQL version. No Vercel or Railway deployment was created. DTM endpoints, credentials and execution guarantees have not been qualified. The complete concurrency, workflow, browser and production acceptance matrix remains NOT_RUN until implementation.

The GitHub main branch contains only the initial repository files; the architecture is maintained on a separate review branch. No merge or deployment is claimed.
