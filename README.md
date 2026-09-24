# ACCESS referral vertical slice

Runnable first vertical slice of the ACCESS healthcare patient-access platform.
It accepts **synthetic data only**, encrypts artifacts, performs fixed-schema
extraction, resolves administrative exceptions, applies action policy, commits
state/evidence/outbox atomically, and dispatches an idempotent mock connector.

## Architecture

- `apps/core-api`: validated command/query HTTP API; no foreign I/O in DB transactions.
- `apps/worker`: leased, ordered outbox dispatcher and ambiguous-write reconciler.
- `apps/console`: minimal Vite/React staff view of state, evidence, work and execution.
- `packages/domain`, `contracts`, `policy`: pure workflow, versioned schemas and policy.
- `packages/db`: tenant transaction helper and atomic command repository.
- `supabase`: repeatable PostgreSQL migration, forced RLS roles/policies and synthetic seed.
- `infra`: Azure Container Apps reference, Vercel console, Railway option and portable image.

The extractor and encrypted artifact store are replaceable ports. The mock
connector supports success, retryable, permanent, deferred, malformed,
capability-withdrawn and committed-then-timeout behavior. An ambiguous result is
reconciled by its original `execution_id`, never blindly retried.

## Prerequisites and one-command local start

Install Node 20+, npm 11+, and Docker Compose. No cloud credentials are needed.

```bash
cp .env.example .env
npm ci
docker compose up --build
```

The API is at `http://localhost:3001`, health at `/health` and readiness at
`/ready`. Run the console separately with `npm -w @access/console run dev` and
open `http://localhost:3000`. Raw artifacts are encrypted under `data/artifacts`.
The checked-in encryption key is an explicitly insecure local example.

Without Compose, start PostgreSQL 16 and run:

```bash
set -a; source .env; set +a
npm run db:migrate
npm run db:seed
npm -w @access/core-api run dev
# separate terminal
npm -w @access/worker run dev
```

## Exercise the flow

All identifiers and content below are synthetic.

```bash
TENANT=11111111-1111-4111-8111-111111111111
REFERRAL=$(node -e 'console.log(crypto.randomUUID())')
COMMAND=$(node -e 'console.log(crypto.randomUUID())')
CORRELATION=$(node -e 'console.log(crypto.randomUUID())')
curl -sS http://localhost:3001/v1/referrals -H 'content-type: application/json' \
  -d "{\"command_id\":\"$COMMAND\",\"tenant_id\":\"$TENANT\",\"referral_id\":\"$REFERRAL\",\"correlation_id\":\"$CORRELATION\",\"expected_version\":0,\"filename\":\"synthetic.txt\",\"media_type\":\"text/plain\",\"content_base64\":\"c3ludGhldGljIHJlZmVycmFs\",\"fixture\":\"complete\"}"
curl -sS -H "x-tenant-id: $TENANT" "http://localhost:3001/v1/referrals/$REFERRAL"
```

Use `missing-insurance`, `ambiguous-identity`, or `urgent` as fixture values to
open a human exception. Resolve one with `POST /v1/referrals/:id/resolve`, the
tenant header, a new command/correlation UUID, current `expected_version`, a
resolution (`confirm_identity`, `provide_insurance`, `approve_deferred`, or
`reject`) and a nonempty note. Start the worker with
`CONNECTOR_FAULT_MODE=committed-timeout` to prove reconciliation.

## Checks and qualification

```bash
npm run format
npm run lint
npm run typecheck
npm run test:unit
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/access_test npm run test:integration
npm run test:fault
npm test
npm run build
npm run validate:infra
npm run check:secrets
LOAD_BASE_URL=http://localhost:3001 npm run load
```

The real-Postgres integration suite reapplies migrations, forces a rollback at a
write boundary, and checks missing/cross-tenant context across every tenant
table. CI provisions PostgreSQL and runs the complete suite. The provisional
load profile assumes one small practice, 25 active tenants, a burst of 10, 200
health requests and p95 under 250 ms; these are measurement inputs, not an SLO.
Artifact limit is 10 MB. The owner must approve or revise limits using recorded
staging evidence before release.

## Deployment

Build and push one immutable image and provision Supabase with three credentials.
`MIGRATION_DATABASE_URL` is used only by `npm run db:migrate`; the API receives
only `API_DATABASE_URL` (`access_request`) and the worker only
`WORKER_DATABASE_URL` (`access_worker`). Run every ordered migration, then run
`supabase/provisioning/runtime-roles.sql` as the owner with passwords supplied as
psql variables. Runtime startup in staging/production rejects the wrong role,
superuser/BYPASSRLS, or table ownership. Never reuse the migration URL at runtime.

```bash
docker build -t "$REGISTRY/access:$GIT_SHA" .
docker push "$REGISTRY/access:$GIT_SHA"
RESOURCE_GROUP=access-prod PREFIX=access-prod IMAGE="$REGISTRY/access:$GIT_SHA" \
  DATABASE_URL="$SUPABASE_DATABASE_URL" infra/azure/deploy.sh
vercel deploy --prod --cwd apps/console
# Railway: create two services from the same image. Select
# infra/railway/api.railway.toml and infra/railway/worker.railway.toml respectively.
```

The Railway API has a public domain, `/ready`, `API_DATABASE_URL`,
`ARTIFACT_ROOT`, `ARTIFACT_ENCRYPTION_KEY`, `CONSOLE_ORIGIN`, and
`ALLOW_SYNTHETIC_TENANT_CONTEXT=true`. The worker has no domain or HTTP health
check, starts `node apps/worker/dist/main.js`, has one replica, and receives only
`WORKER_DATABASE_URL`, `DISPATCH_MAX_ATTEMPTS`, `RECONCILE_MAX_ATTEMPTS`, and
`RECONCILE_BASE_SECONDS`. Vercel receives only `VITE_CORE_API_URL`; it receives
no database or service-role secret. Configure the API and worker as separate Azure Container App revisions from the
same image. Store database and
artifact keys in Azure Key Vault/Container Apps secrets, require database TLS,
restrict connector egress, and set the console's `VITE_CORE_API_URL` at build
time. Vercel receives only the public core API URL and workforce-auth settings,
never a Supabase service role or storage key.

Before real data, validate Bicep with `az bicep build --file
infra/azure/main.bicep`, deploy isolated staging, execute the full suite, scan
image/dependencies, exercise every alert/runbook, and perform the documented
PITR restore. Capture deployment output, test logs, image digest, RLS role
inspection, restore RPO/RTO, load JSON and evidence-chain comparison in the
release record. Cloud deployment, real malware scanning, workforce JWT
verification, managed object storage, production key rotation, production
telemetry/alerting, real connector qualification, DAST/penetration testing,
formal privacy/security approval, short-lived execution grants and restore
evidence remain explicit pre-live gates. **This remains synthetic staging only.**

See [the architecture ADR](docs/adr/0001-production-slice.md), [security
assumptions](docs/security.md), and [operator runbooks](docs/runbooks.md).
