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
