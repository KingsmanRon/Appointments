# Operator runbooks

## Stuck or poison outbox

Alert when oldest pending age exceeds the approved load result. Query by status,
tenant, correlation and execution ID; do not copy payloads into tickets. Confirm
connector health. Expired leases are reclaimable. A poison row requires root
cause and a human exception; never reset an ambiguous effect for blind retry.

## Ambiguous connector write

Keep the referral in `RECONCILING`. Invoke read-back with the original
`execution_id`. On a unique committed result, record success; after bounded
reconciliation with no unique match, open an exception. Never allocate another
execution ID for the same intended effect.

The worker uses capped exponential scheduling (`RECONCILE_BASE_SECONDS`, maximum
300 seconds) and `RECONCILE_MAX_ATTEMPTS`. An inconclusive poll updates technical
attempt metadata only: it does not change aggregate version or append duplicate
domain evidence. Exhaustion atomically moves the referral to `EXCEPTION`, opens
one connector work item and appends escalation evidence.

## Artifact transaction failure

Local staging storage uses a deterministic object key and exclusive encrypted
write. If ingest later rolls back, a newly created encrypted object is deleted;
an already existing idempotent object is retained. No plaintext is written.

## Database interruption and restore

Stop dispatchers, capture queue watermark, restore the provider PITR backup into
an isolated project, run `npm run db:migrate`, compare evidence chain heads and
execution IDs, then execute tenant-isolation and reconciliation tests. Record
actual RPO/RTO; no target is claimed until this exercise is run in staging.

## Credential expiry / rollback

Rotate through the secret manager and restart one revision. Application rollback
uses the prior immutable image only while schema remains backward compatible;
otherwise deploy a tested forward fix. Verify `/ready`, queue age and one
synthetic end-to-end referral before resuming dispatch.
