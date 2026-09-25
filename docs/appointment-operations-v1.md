# ACCESS Appointment Operations v1

**Status:** synthetic-staging qualified. The only appointment connector is
the deterministic mock (`CONNECTOR_KIND=mock`). No real practice management
system (PMS) is integrated; a real connector must pass
[connector qualification](connector-qualification.md) on its own before any
live practice uses it.

## 1. Business scope

ACCESS already took a referral from arrival to `READY_FOR_BOOKING` and
measured what happened next. v1 makes the Booking stage real:

```text
referral READY_FOR_BOOKING
  → APPOINTMENT_REQUEST opened ("Start booking")
  → availability read from the destination
  → staff select a slot
  → slot held (where the destination supports holds)
  → booking committed by the worker, exactly once
  → appointment recorded, referral BOOKED
  → staff record the patient's confirmation
```

and, for a committed appointment, **rescheduling** (replacement first, original
last) and **cancellation**.

ACCESS remains administrative. It never decides diagnosis, clinical urgency,
prioritisation, treatment or provider suitability. Slots are offered exactly
as the destination returns them; staff choose. No model, browser or free text
can create, cancel or replace an appointment: only a typed, policy-checked,
idempotent command executed by the worker can.

## 2. Architecture

Nothing new is deployed. The feature extends the existing modules:

| Module                | Change                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `packages/contracts`  | appointment vocabulary, typed connector payloads/results, command schemas                   |
| `packages/domain`     | appointment case transitions, booking sub-flow rules, plain-language status                 |
| `packages/policy`     | case-type enablement, operation binding, RBAC for booking/reschedule/cancel                 |
| `packages/db`         | appointment request/appointment/hold data access, booking metrics                           |
| `apps/core-api`       | commands (`/actions` start_booking, `/appointment-actions`, `/v1/appointments/:id/actions`) |
| `apps/worker`         | same dispatcher and reconciler; appointment settlement; hold expiry timer                   |
| `apps/console`        | Booking stage expanded into Availability → Select → Hold → Commit → Confirm                 |
| `supabase/migrations` | `0006_appointment_operations.sql` (additive)                                                |

The browser never talks to the destination. The API validates, authorises,
evaluates policy and records a command plus outbox rows in one transaction;
the worker performs every foreign effect, including reads, so connector
credentials exist only in the worker.

## 3. Data model

`access_cases` stays the high-level aggregate. Appointment detail lives in
three new tenant tables (forced RLS, composite tenant foreign keys, no
DELETE/TRUNCATE for runtime roles):

| Table                    | One row per                                    | Key facts                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `appointment_requests`   | APPOINTMENT / RESCHEDULING / CANCELLATION case | originating referral, booking context, search window and time zone, workflow status, latest availability snapshot, selected slot, current hold, pending execution, result appointment, version |
| `appointments`           | committed foreign appointment                  | destination and external reference (immutable), provider/location/service, start, end, time zone, status, committed/cancelled times, `replaces`/`superseded_by`, confirmation, version         |
| `appointment_slot_holds` | reservation at the destination                 | slot reference, destination hold reference, execution, created/expires, status `ACTIVE → CONSUMED \| RELEASED \| EXPIRED`                                                                      |

Alternative considered: separate extension tables per request type. One
`appointment_requests` table serves all three because rescheduling repeats the
booking sub-flow exactly and cancellation is a subset; a composite foreign key
`(tenant_id, case_id, case_type) → access_cases` keeps each row bound to a case
of the matching type, and `CHECK`s enforce per-type columns and statuses.

Patient data is not copied. The booking context is the destination's own
referral reference, the destination patient reference when the referral
supplied one, the service code and the routing queue.

## 4. State model

Business state and execution state stay separate. `access_cases.current_state`
keeps the queue-level lifecycle; the booking sub-flow is
`appointment_requests.workflow_status`; connector progress stays on
`executions` (`PENDING … POISON`). No business state means "timeout" or
"retry".

Appointment cases use their own transition table (case-type aware in both
`packages/domain` and the `case_transition_guard` trigger); referral
transitions are unchanged:

```text
RECEIVED ──> WAITING (external action pending) | READY_FOR_BOOKING | EXCEPTION | CLOSED
READY_FOR_BOOKING (staff decision needed) ──> WAITING | EXCEPTION | CLOSED
WAITING ──> READY_FOR_BOOKING | BOOKED | EXCEPTION | CLOSED
EXCEPTION ──> READY_FOR_BOOKING | WAITING | BOOKED | CLOSED
BOOKED, CLOSED: terminal
```

`EXCEPTION → BOOKED` exists only for a reschedule whose last uncertainty (the
original's cancellation) is settled by read-back or by an audited staff
attestation.

Booking sub-flow (`workflow_status`):

```text
APPOINTMENT_REQUEST / RESCHEDULING_REQUEST
AVAILABILITY_REQUESTED ─> AVAILABILITY_RETURNED | NO_AVAILABILITY
AVAILABILITY_RETURNED ─> SLOT_SELECTED ─> HOLD_REQUESTED ─> HELD
SLOT_SELECTED | HELD ─> BOOKING_SUBMITTED ─> BOOKED               (appointment request)
                                          └> REPLACEMENT_BOOKED     (reschedule: B committed)
                                             ─> ORIGINAL_CANCELLATION_PENDING (B verified)
                                             ─> COMPLETED           (A cancelled, superseded by B)
refusals return to AVAILABILITY_RETURNED / SLOT_SELECTED with last_failure_code

CANCELLATION_REQUEST
CANCELLATION_REQUESTED ─> CANCELLATION_SUBMITTED ─> CANCELLED

any request ─> WITHDRAWN (only when no foreign effect is unresolved)
```

The originating referral follows: starting a booking records a
`BOOKING_REQUESTED` observation (READY_FOR_BOOKING → WAITING) and pauses its
follow-up timer; a committed booking records `APPOINTMENT_BOOKED`
(EXTERNAL_CONFIRMED) through the same observation engine as every other
outcome, so a referral in EXCEPTION or already resolved is never moved by it;
a withdrawn request returns the referral to READY_FOR_BOOKING. While a booking
is active, referral outcome actions are refused (`BOOKING_IN_PROGRESS`) so staff
cannot record a second booking by hand.

## 5. Connector contract

Operations (`OPERATIONS`), each bound to the case types that may authorise it:

| Operation                                | Capability                      | Case types                | Consequential |
| ---------------------------------------- | ------------------------------- | ------------------------- | ------------- |
| `appointment.availability.read`          | `appointment.availability.read` | APPOINTMENT, RESCHEDULING | no (a read)   |
| `appointment.hold`                       | `appointment.hold`              | APPOINTMENT, RESCHEDULING | yes           |
| `appointment.hold.release`               | `appointment.hold`              | APPOINTMENT, RESCHEDULING | no            |
| `appointment.create`                     | `appointment.create`            | APPOINTMENT_REQUEST       | yes           |
| `appointment.reschedule` (commit B)      | `appointment.reschedule`        | RESCHEDULING_REQUEST      | yes           |
| `appointment.reschedule.verify` (read B) | `appointment.status.read`       | RESCHEDULING_REQUEST      | no            |
| `appointment.reschedule.cancel_original` | `appointment.reschedule`        | RESCHEDULING_REQUEST      | yes           |
| `appointment.cancel`                     | `appointment.cancel`            | CANCELLATION_REQUEST      | yes           |

Every request is `connector-request.v1` with a typed payload
(`appointment-availability-query.v1`, `appointment-hold-request.v1`,
`appointment-booking-request.v1`, `appointment-cancellation-request.v1`, …).
`SUCCEEDED` carries `data` validated per operation (`appointment-availability.v1`,
`appointment-hold.v1`, `appointment-commit.v1`, `appointment-status.v1`,
`appointment-cancellation.v1`). An invalid `data` after a consequential write
is treated as ambiguous. Read-back may return the new `NOT_COMMITTED` result:
the destination authoritatively holds no effect for that `execution_id`.

`AppointmentSlot` = slot reference, provider/location reference, start/end
(UTC instants), IANA time zone, `hold_supported`, `hold_expires_at`. No opaque
connector metadata is stored.

## 6. Slot-hold semantics

- A slot shown to staff is **not** a reservation. Availability is stored as a
  snapshot with `observed_at`; selecting or booking an unheld slot from a
  snapshot older than 10 minutes is refused (`AVAILABILITY_STALE`).
- The destination declares holds by the `appointment.hold` capability; the
  worker marks slots `hold_supported=false` when the capability is not
  enabled. Holding an unheld slot is refused (`HOLD_NOT_SUPPORTED`).
- Unheld booking relies on the destination's atomic commit: a lost race comes
  back as `SLOT_UNAVAILABLE` and the request returns to selection.
- Every hold has an expiry set by the destination. The API refuses to submit a
  booking against a hold with less than 15 seconds left (`HOLD_EXPIRED`); the
  worker's timer marks lapsed holds `EXPIRED`; a database trigger allows only
  `ACTIVE → CONSUMED | RELEASED | EXPIRED`, so an expired hold can never be
  consumed.
- Choosing another slot, searching again or withdrawing releases the current
  hold (best effort; an unreleased hold expires).

## 7. Booking invariants

1. Only a request whose originating referral is still bookable
   (READY_FOR_BOOKING or WAITING, no safety hold, booking prerequisites of its
   pinned rule set met) may submit a booking; the check is repeated at commit.
2. The command carries `command_id`, `expected_version` and the exact selected
   slot; the request hash binds them. Policy (`appointment-policy.v1`) is
   evaluated and recorded before the outbox row is written.
3. One active booking request per referral (partial unique index) and one
   in-flight booking per request (`pending_execution_id`).
4. The worker is the only writer of `appointments`. BOOKED requires a
   `SUCCEEDED` result bound to the execution (`execution_id` echoed) with a
   valid `appointment-commit.v1`, or a read-back that finds it.
5. A late or foreign result never mutates the workflow: settlement requires
   the execution to be the request's `pending_execution_id`.

## 8. Reschedule invariant

The original appointment A is never touched until its replacement B is
committed **and** read back:

```text
commit reschedule (one staff command, one policy decision)
  outbox: [commit B: PENDING] → [verify B: BLOCKED] → [cancel A: BLOCKED]
  B committed (or found by read-back)  → verify B released
  B read back BOOKED                   → cancel A released
  A cancelled                          → A SUPERSEDED (superseded_by B), request COMPLETED
```

`BLOCKED` outbox rows are pre-authorised by the staff command but are never
claimed until the worker releases them after the previous step is verified.
If B is refused or confirmed not committed, the remaining steps are closed
unexecuted and A is untouched. If B is ambiguous, A is untouched while B is
reconciled. If B is committed but A's cancellation is ambiguous, the case moves
to EXCEPTION immediately with a work item stating that **both appointments may
currently exist**, and A's cancellation is reconciled; only a read-back (or a
manager's attestation after checking the destination) completes the reschedule.

## 9. Cancellation invariant

Cancellation needs a committed appointment in the same tenant, a
PRACTICE_MANAGER or ADMIN, the appointment's `expected_version`, a reason and
a separate commit. The cancel carries the exact external reference. On success
the appointment becomes CANCELLED, the CANCELLATION_REQUEST closes with
`CANCELLED`, an `APPOINTMENT_CANCELLED` observation is recorded, and the
referral's booked outcome is not rewritten: the cancellation is raised to a
manager as an outcome review. A repeated command replays; a second
cancellation of the same appointment is refused (one active change per
appointment) and the destination de-duplicates by `execution_id`.

## 10. Ambiguous writes

Consequential appointment writes follow the existing rule: retry
automatically only when the effect is known not to have happened
(`SafeRetryableConnectorError`, `RETRYABLE`). Timeouts, resets, throws or
malformed results after send make the execution `AMBIGUOUS`; the reconciler
reads the destination back by the original `execution_id` (capability
`appointment.status.read`) and:

- finds the effect → settles exactly as a success (no second write);
- `NOT_COMMITTED` → the request returns to a recoverable state (re-select,
  re-hold, re-submit the cancellation); for a reschedule's cancel-A step the
  same execution is re-armed automatically, because the effect is known absent;
- stays inconclusive → bounded backoff, then EXCEPTION and a CONNECTOR work
  item; staff may `recheck` (re-arm the read-back) or, having checked the
  destination, `attest_not_committed`.

Staff language: "Booking submitted. The destination system has not yet
confirmed whether it was committed. ACCESS is checking before attempting
anything else."

## 11. RBAC

| Role                 | Appointment permissions                                                                 |
| -------------------- | --------------------------------------------------------------------------------------- |
| READ_ONLY            | read only (patient details hidden as before)                                            |
| REFERRAL_COORDINATOR | start booking, search, select, hold, book, withdraw/recheck/attest own booking, confirm |
| PRACTICE_MANAGER     | above + reschedule and cancellation (initiate, commit, withdraw, attest)                |
| ADMIN                | above + rule sets and memberships                                                       |

Coordinators do not reschedule or cancel in v1: both remove a committed
appointment from the destination, so they sit with the manager role, matching
outcome corrections. Roles always come from server-side membership.

## 12. API

| Method & path                                | Permission                                          | Purpose                                                                                                          |
| -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `POST /v1/cases/:id/actions` `start_booking` | coordinator+                                        | open an APPOINTMENT_REQUEST from an eligible referral and read availability                                      |
| `POST /v1/cases/:id/appointment-actions`     | per action and case type                            | `search`, `select`, `hold`, `commit`, `withdraw`, `recheck`, `attest_not_committed`, `attest_original_cancelled` |
| `GET /v1/appointments/:id`                   | any                                                 | appointment state, linked cases, pending change                                                                  |
| `POST /v1/appointments/:id/actions`          | confirm: coordinator+; reschedule, cancel: manager+ | `confirm`, `reschedule` (opens a RESCHEDULING_REQUEST), `cancel` (opens a CANCELLATION_REQUEST)                  |
| `GET /v1/cases/:id`                          | any                                                 | adds `appointment_request`, `appointments`, `access_status`                                                      |
| `GET /v1/cases?filter=`                      | any                                                 | adds `booking_in_progress`, `reschedule`, `cancellation`                                                         |

All writes carry `command_id` (request-hash bound), `correlation_id` and
`expected_version`; tenant and actor come from the authenticated membership.

## 13. Metrics

Cohort measures keep provenance (`OBSERVED`, `DERIVED`, `UNKNOWN`; nothing
missing becomes zero):

- ready-for-booking → booked conversion; median and p95 time from
  DESTINATION_COMMITTED to booked;
- booking attempts per booked appointment; availability searches per booking;
- slot selection → booking success; abandoned booking requests;
- reschedules completed; cancellations completed;
- ambiguous external writes on appointment operations;
- staff interventions on appointment cases per booking request.

No ROI and no benchmarks.

## 14. Status

`patientAccessStatus` (pure, in `packages/domain`) answers "what is happening
with this referral/appointment?" from the case, the active request, the
appointments and the executions: Referral in progress, Referral complete,
Ready for booking, Searching for appointment, Slot selected / awaiting commit,
Booked, Confirmed, Reschedule in progress, Cancelled, Needs staff attention.
A status enquiry interaction returns it; nothing is generated by a model.

## 15. Future patient self-service seam

A secure patient surface could reuse the same commands without exposing staff
APIs or tenant secrets:

```text
eligible referral (READY_FOR_BOOKING) → verified patient identity (portal auth,
e.g. one-time code bound to the referral) → availability (search) → slot
choice (select/hold) → booking (commit)
```

It would be a separate, narrow edge (`PATIENT_PORTAL` channel, patient actor,
scoped token naming one referral) that maps onto the same command handlers,
policy and outbox; it never sees other patients, other tenants or connector
credentials. It is not built in v1; the channel stays disabled.

## 16. What remains disabled

- `STATUS_ENQUIRY` and `MISSING_INFORMATION` as independent case types
  (they remain interactions on a referral).
- EMAIL, WHATSAPP, VOICE and PATIENT_PORTAL channels; no message is sent, so
  a confirmation is always a staff attestation.
- Rebooking a referral after its appointment is cancelled (the cancellation is
  raised for manager review; a new referral is needed in v1).
- Real PMS connectors: `CONNECTOR_KIND` is `mock` or `none`; the mock refuses
  REAL data.
