# Build pack validation

Finalised on 21 September 2026.

## Completed checks

1. Consolidated the original architecture, revised proposal and review corrections into one implementation baseline.
2. Checked relevant official Supabase, Vercel and Railway documentation. The deployment document links its sources. The Supabase markdown changelog endpoint was unavailable through the browser tool, so the official HTML changelog and documentation search were used.
3. Applied the complete final database/schema.sql to a separate empty local PostgreSQL 18.1 database with ON_ERROR_STOP enabled. The transaction completed successfully.
4. Verified ENABLE and FORCE RLS on all 42 domain tables. One additional protected authz table stores database identity mappings.
5. Ran database/validate_reference.py against real tenant LOGIN connections. Result: 37 PASS, zero FAIL. The machine readable evidence is database/validation_result.json.

The smoke checks cover tenant visibility, unregistered identity denial, resistance to a forged tenant setting, denied role switching and principal map access, cross tenant writes and references, worker permissions, authority guard locking, immutable execution bodies and approvals, command receipt immutability, valid state names, upload jobs before referral creation, recovery lane constraints, grant to attempt binding, atomic rollback, irreversible consumption, one STARTED attempt, immutable manual plans, unknown effort, session revocation records and accepted artefact scan/immutability checks.

## Corrected findings and retained evidence

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

The pack is ready for the implementation phase. The application has not been built. Its API handlers, atomic authorise_and_start implementation, frontend, OCR/scanner integration, workers and connector adapters remain the builder's deliverables.

No hosted Supabase schema was applied. Supabase role provisioning, session pooler identity behaviour, Auth and Storage must be verified on the selected project's actual PostgreSQL version. No Vercel or Railway deployment was created. DTM endpoints, credentials and execution guarantees have not been qualified. The complete concurrency, workflow, browser and production acceptance matrix remains NOT_RUN until implementation.

The initial Git repository had no commits or remote. The proposals were merged into this pack; no Git branch merge or remote push is claimed.
