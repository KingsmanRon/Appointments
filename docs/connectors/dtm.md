# DTM connector

`CONNECTOR_KIND=dtm` delivers ready referrals to DTM's **Referral inbox**
through DTM's ACCESS integration API (KingsmanRon/dtm-inc,
`docs/integrations/access.md`). Reception at the practice then links each
referral to the patient's file or declines it. DTM has no appointment book,
so booking stays manual (`record_booking`).

The connector is **synthetic only** until it is qualified against a DTM
staging copy: the worker refuses `CONNECTOR_KIND=dtm` with
`ACCESS_DATA_MODE=REAL`.

| ACCESS does                                                             | ACCESS does not                                                                                                     |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Send the referral that was judged ready, once per execution             | Create, read or change a DTM patient file                                                                           |
| Read back by execution id whether DTM stored it                         | Look patients up in DTM: DTM suggests a matching file to reception itself, so its patient register cannot be probed |
| Record DTM's inbox reference (`IN-000042`) as the destination reference | Send documents: it names the documents it holds (`documents_held`) and keeps them                                   |

## Flow

1. A referral becomes ready and its rule set routes it to the connector:
   the case enters `DESTINATION_PENDING` with a `referral.create` outbox item.
2. The dispatcher builds the delivery in memory from the facts that made the
   referral ready, read the way the rules read them (staff corrections over
   the extraction). It is never written to the outbox, executions, evidence
   or logs. If a required fact is missing, nothing is sent and staff get a
   `MANUAL_DESTINATION` work item (`REFERRAL_DELIVERY_INCOMPLETE`).
3. The connector sends a signed `POST /api/v1/integrations/access/referrals`.
4. On success the case moves to `READY_FOR_BOOKING`, with DTM's inbox reference
   recorded as the destination reference (source `CONNECTOR`).

Only connectors that declare `sendsReferralContent` on `referral.create`
receive the delivery. The mock connector does not, so it never sees patient
details.

## What is sent

`access-referral-delivery.v1` contains the execution, correlation and tenant
ids and the data mode. The referral inside it has these fields:

- `case_reference` (`REF-…`), `referral_id`, `received_at`;
- `patient`: given name, family name, date of birth and, if known, the ID or
  passport number;
- `referrer.name`, `reason`, `requested_service`, `referral_date`, `funding`;
- `documents_held`.

The request is signed with HMAC-SHA256 over method, path, timestamp and body
hash (`apps/worker/src/dtm-signature.ts`). DTM refuses a request more than
five minutes from its clock. Both repositories test the same signing vector.

## How DTM's answers are handled

| DTM answers                                                       | Result                               | What ACCESS does                                             |
| ----------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `201`, or `200` for a replay                                      | `SUCCEEDED` with the inbox reference | `READY_FOR_BOOKING`                                          |
| `409 idempotency_conflict`                                        | `AMBIGUOUS`                          | Reads back; the stored delivery is ours from an earlier send |
| `503 integration_disabled`                                        | `PERMANENT DTM_INTEGRATION_DISABLED` | `EXCEPTION`; staff retry later or enter it by hand           |
| `401`, `403`, `409 data_mode_mismatch`, `413`, `422`, other `4xx` | `PERMANENT DTM_<reason>`             | `EXCEPTION` with a connector work item; nothing was stored   |
| `3xx`                                                             | `PERMANENT DTM_HTTP_3xx`             | Never followed: a signed request is not replayed elsewhere   |
| `408`, `429`, or a gateway's `503`                                | `RETRYABLE`                          | Same execution sent again later; DTM de-duplicates it        |
| DTM unreachable before sending (refused, DNS, TLS)                | Safe retry                           | Same as above                                                |
| `5xx`, timeout, lost connection, unreadable receipt               | `AMBIGUOUS`                          | Read back by execution id, never re-sent                     |

Read-back (`GET /referrals/{execution_id}`):

| DTM answers                       | Result                               |
| --------------------------------- | ------------------------------------ |
| `200` with the execution's status | `SUCCEEDED` with the inbox reference |
| `404 not_found`                   | `AMBIGUOUS` (`DTM_NOT_STORED`)       |
| Anything else                     | `AMBIGUOUS`                          |

A `404` is not treated as proof that the delivery is absent: a slow send can
still be stored while its signature is within DTM's five-minute window. The
dispatcher keeps reading back. If the delivery never appears, the case goes
to staff (`RECONCILIATION_EXHAUSTED`). Staff check DTM's inbox and retry with
an attestation, which sends a new execution.

`getReferralStatus` reads `GET /referrals?reference=IN-…`: `pending` is
`RECEIVED`, `accepted` is `ACCEPTED`, `declined` is `CLOSED`.

## Configuration (worker only)

| Variable             |                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `CONNECTOR_KIND=dtm` | Implemented capabilities: `referral.create`, `referral.status.read`                                                        |
| `DTM_BASE_URL`       | Origin only, e.g. `https://dtm.example.org`. Must be https, except `http://localhost`                                      |
| `DTM_KEY_ID`         | The key id in DTM's `ACCESS_INTEGRATION_KEYS`                                                                              |
| `DTM_SECRET`         | The matching secret, at least 32 characters. Keep it in the secret store, never in the repository (the secret scan checks) |
| `DTM_TIMEOUT_MS`     | Default `10000`, at most `20000`, so it stays under the 30-second dispatch lease                                           |

DTM's side needs the same key id and secret, `ACCESS_INTEGRATION_TENANT_ID`
set to this organisation's id, and `ACCESS_INTEGRATION_DATA_MODE=synthetic`.

**Rotating keys.** DTM accepts two keys during a rotation. Add the new key on
DTM, switch `DTM_KEY_ID` and `DTM_SECRET` here, then remove the old key on DTM.

## Tests

| Suite                                     | Covers                                                                                                                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/unit/dtm-signature.test.ts`        | The signing vector shared with DTM                                                                                                                                                                           |
| `tests/unit/referral-delivery.test.ts`    | Delivery content, staff corrections, refusal of partial deliveries                                                                                                                                           |
| `tests/fault/dtm-connector.test.ts`       | Every answer above, against a fake DTM that applies DTM's schema and checks signatures with its own code                                                                                                     |
| `tests/integration/dtm-connector.test.ts` | The dispatcher on PostgreSQL with the fake DTM: delivery, timeout after storing, 500 before storing then attested retry, gateway retry, data-mode refusal, incomplete delivery, no patient details persisted |

## Qualification before real referrals

Against a DTM staging copy in `synthetic` mode, with evidence:

1. The happy path: delivery visible in DTM's inbox, and its reference recorded in ACCESS.
2. The same execution delivered twice gives one inbox row.
3. A forced timeout after storing is reconciled to the single row.
4. Refusals (wrong tenant, wrong data mode, bad signature) store nothing.
5. Reception links and declines, and `getReferralStatus` follows both.
6. Throughput and latency at pilot volume; the worker's egress is restricted
   to DTM's origin.

Then, in one change, record the evidence in `docs/connector-qualification.md`,
lift the `REAL` refusal in `packages/config`, and switch both sides to real
data on the same day. DTM's go-live steps list the practice's approvals.
