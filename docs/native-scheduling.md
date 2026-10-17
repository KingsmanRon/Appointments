# Native scheduling (Dr M's appointment book)

ACCESS keeps the practice's own appointment book. Reception books telephone
calls, walk-ins and ready referrals into the doctor's diary, runs the day
(check in, did not attend, move, cancel), and the doctor reads their own
calendar by day or week. No mock or external destination is involved:
appointments live in ACCESS's PostgreSQL database. DTM remains the
patient-records system.

Synthetic data only until the client-pilot checklist is complete.

## What owns what

| Thing                                                    | Owner                                             | How the other side sees it                                                                                         |
| -------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Practitioners, working hours, blocked time, appointments | ACCESS (migration `0007`)                         | Not shared with DTM in this version                                                                                |
| Patient records, consent, clinical notes                 | DTM                                               | ACCESS holds only what reception needs to book and recognise the patient (name, optional date of birth, phone, ID) |
| Referral intake and delivery to DTM's inbox              | ACCESS → DTM ([DTM connector](connectors/dtm.md)) | Unchanged by this work                                                                                             |

There is no direct database access between ACCESS and DTM. Linking a
telephone or walk-in patient to their DTM file stays a reception step in DTM.

## Model

- **`practitioners`**: display name, time zone, slot length, default
  appointment length, and the workforce actor (`user:<JWT subject>`, or
  `synthetic:<user>` in development) whose `PRACTITIONER` membership reads
  this calendar.
- **`practitioner_working_hours`**: a weekly template. Each session is an ISO
  weekday plus start and end minutes in the practitioner's time zone, so
  lunch is two sessions. An exclusion constraint stops sessions on one day
  overlapping. Replacing the template retires the old rows with
  `removed_at`; nothing is deleted.
- **`practitioner_blocks`**: leave, meetings and other unavailable periods.
  A block cannot be placed over a booked appointment; move or cancel the
  appointment first.
- **`scheduled_appointments`**: channel (`TELEPHONE`, `WALK_IN` or
  `REFERRAL`), patient details, reason, start and end, status, and who did
  what and when. A `REFERRAL` booking must point at an ACCESS referral case
  (enforced by a composite foreign key). The other channels have none.
- **`scheduled_appointment_events`**: an append-only history of every
  decision, with no patient details.

### The invariant

```sql
CONSTRAINT appointments_no_practitioner_overlap EXCLUDE USING gist (
  tenant_id WITH =, practitioner_id WITH =, occupied WITH &&
) WHERE (status IN ('BOOKED','CHECKED_IN','COMPLETED'))
```

PostgreSQL refuses an overlapping appointment whatever the application does.
When two receptionists book the same time, both transactions pass the
application checks. The second insert waits on the first, then fails with
`23P01`, which the API reports as `409 SLOT_UNAVAILABLE`.

Other rules enforced in the database:

- **Immutable bookings.** Patient, time, channel and practitioner never
  change. A guard trigger refuses the update, and a new time is a new row.
- **No deletion.** Appointments are never deleted, and the history table is
  append-only (truncation is refused too).
- **State machine.** Status changes follow a fixed set of transitions,
  mirrored in TypeScript; a unit test compares the two. The arrows are:
  - `BOOKED` → `CHECKED_IN`, `CANCELLED`, `NO_SHOW`, `RESCHEDULED`
  - `CHECKED_IN` → `COMPLETED`, `CANCELLED`
  - `NO_SHOW` → `CHECKED_IN` (a late arrival)
- **Versioning.** Each change must advance `version` by exactly one. The API
  checks `expected_version`, so a stale screen cannot overwrite a newer
  decision.
- **One live booking per referral.** A referral has at most one live
  appointment (a partial unique index).

### Transactions and locks

Every command is one transaction under the caller's tenant, role and actor,
and runs at most once per `command_id`:

- A retried request replays the stored result.
- A reused id with different content returns `409 IDEMPOTENCY_CONFLICT`.
- The stored result names the appointment, never the patient.

Locks on the practitioner row keep configuration and bookings apart:

- Bookings and reschedules take it `FOR SHARE`, so bookings for different
  times run concurrently.
- New working hours and blocks take it `FOR UPDATE`, so they never race a
  booking.

**Rescheduling.** The original is closed as `RESCHEDULED` and the
replacement is inserted in the same transaction, linked both ways by
deferred foreign keys. The replacement may overlap the original's old time.
If the new time is taken, both changes roll back and the original is exactly
as it was.

**Referral bookings.** The patient comes from the referral's resolved facts,
never from the browser. The referral must pass the existing booking
readiness rules, and no connector execution may be in flight. The booking
and the referral's `APPOINTMENT_BOOKED` observation (which moves the
referral to `BOOKED`) commit together.

- **Moving a referral appointment** adds evidence to the referral.
- **Cancelling one** records `APPOINTMENT_CANCELLED`, which raises the
  booked referral for manager review. This is the existing v1 rule.

### Availability

Free times are computed in SQL:

1. Expand the working sessions over the requested dates in the
   practitioner's time zone (`AT TIME ZONE`).
2. Step through them by the slot length.
3. Drop past times, blocked periods and occupied time.

A booking must:

- start on a whole minute;
- start no more than five minutes in the past (for walk-ins);
- fit entirely inside one working session;
- avoid every active block.

## Who can do what

| Role                               | Can                                                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REFERRAL_COORDINATOR` (reception) | See every practitioner's calendar with patient details and phone; book; reschedule; cancel; check in; record did-not-attend; mark completed                                       |
| `PRACTICE_MANAGER`, `ADMIN`        | All of reception, plus practitioners, working hours and blocks                                                                                                                    |
| `PRACTITIONER` (Dr M)              | Their own calendar only, with name, date of birth and reason (no phone or ID); mark their own checked-in patients completed. No referral queue, no booking, no other practitioner |
| `READ_ONLY`                        | Calendars without patient details                                                                                                                                                 |

**Defence in depth.** Row-level security adds restrictive policies keyed on
`app.actor_id`. A `PRACTITIONER` session can read only its own
practitioner, hours, blocks, appointments and history, even if the
application asked for more. The worker login has no privileges on the
scheduling tables.

## API

| Method and path                                                            | Who                                                         | Purpose                                                                      |
| -------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /v1/schedule/practitioners`                                           | reception+, practitioner (self)                             | Practitioners                                                                |
| `POST /v1/schedule/practitioners`                                          | manager+                                                    | Create a practitioner                                                        |
| `POST /v1/schedule/practitioners/:id/working-hours`                        | manager+                                                    | Replace the weekly template                                                  |
| `POST /v1/schedule/practitioners/:id/blocks`                               | manager+                                                    | Block time                                                                   |
| `POST /v1/schedule/practitioners/:id/blocks/:blockId/remove`               | manager+                                                    | Remove a block                                                               |
| `GET /v1/schedule/practitioners/:id/availability?from&to&duration_minutes` | reception+, read-only                                       | Free times                                                                   |
| `GET /v1/schedule/calendar?practitioner_id&from&to`                        | reception+, read-only; a practitioner always gets their own | Day or week view (up to six weeks)                                           |
| `POST /v1/schedule/appointments`                                           | reception+                                                  | Book (`TELEPHONE` needs a phone number; `REFERRAL` takes `referral_case_id`) |
| `GET /v1/schedule/appointments/:id`                                        | as calendar                                                 | Appointment and history                                                      |
| `POST /v1/schedule/appointments/:id/actions`                               | reception+; `complete` also by the practitioner             | `reschedule`, `cancel`, `check_in`, `complete`, `no_show`                    |

These refusals are business answers:

| Code                           | Meaning                                           |
| ------------------------------ | ------------------------------------------------- |
| `SLOT_UNAVAILABLE`             | The time is taken                                 |
| `TIME_BLOCKED`                 | The practitioner is unavailable then              |
| `OUTSIDE_WORKING_HOURS`        | Not inside a working session                      |
| `TIME_IN_PAST`, `TIME_INVALID` | Too late, or not on a whole minute                |
| `REFERRAL_NOT_BOOKABLE`        | The referral is not ready, or already booked      |
| `REFERRAL_ALREADY_BOOKED`      | The referral already has a live appointment       |
| `BLOCK_OVERLAPS_APPOINTMENTS`  | Move or cancel those appointments first           |
| `VERSION_CONFLICT`             | Someone else changed the appointment              |
| `INVALID_TRANSITION`           | That status change is not allowed                 |
| `NOT_YET_DUE`                  | Did-not-attend or completed before the start time |
| `IDEMPOTENCY_CONFLICT`         | The `command_id` was reused with other content    |

## Console

- **Reception** (`#/book`):
  - choose how the patient reached the practice;
  - pick a day and a free time (a walk-in can take the next free time);
  - enter the patient's details, or choose a ready referral, then book;
  - the day's list beside the form offers Check in, Did not attend, Move,
    Cancel and Arrived late.
  - After a failure whose outcome is unclear, pressing Book again resends
    the same `command_id`, so it never books twice.
- **Calendar** (`#/calendar`):
  - day and week time grids, showing working hours, blocked time, the time
    now, and appointments coloured by status;
  - on phones, an agenda list instead;
  - selecting an appointment opens its details and history, and a
    checked-in patient can be marked seen.
  - A doctor signing in lands here and has no other page.

## WAW Scheduling Core: what was reused

KingsmanRon/WAW-scheduling (Dr Musa's) was read for proven patterns only. No
code was copied, nothing depends on it, and the WAW repository was not
changed.

| Adopted (re-implemented here)                                                                                             | Not adopted, and why                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Weekday + minute-range working hours with an exclusion constraint                                                         | Multi-location practices, appointment types and buffers: Dr M has one room and one appointment kind |
| A generated `occupied` range and an exclusion constraint on occupying statuses                                            | WAW's patient directory: DTM is the patient system here                                             |
| A SQL transition function mirrored in TypeScript, with a guard trigger that refuses deletes and changes to booked details | Holds, waitlists and notifications: out of scope for v1                                             |
| Rescheduling as a linked replacement with deferred foreign keys                                                           | WAW's practice and tenancy model: ACCESS's own tenancy and roles apply                              |
| Soft removal (`removed_at`) for configuration                                                                             |                                                                                                     |

## Tests

| Suite                                                               | Covers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/scheduling.test.ts`                                     | State machine equals the SQL; weekly template validation; booking and change schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tests/unit/policy.test.ts`                                         | Scheduling permissions per role                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `tests/integration/scheduling.test.ts` (PostgreSQL)                 | Configuration and availability; telephone and walk-in without a referral; double booking and partial overlap; outside hours, past, blocked; idempotent retry; 10 simultaneous bookings for one time give exactly one; overlapping concurrent requests; reschedule racing a booking; reschedule, rollback and history; cancel; check-in, completion, no-show and late arrival; referral booking, its atomicity and concurrency; cancellation raising review; practitioner isolation in the API and in row-level security; read-only redaction; cross-tenant refusal; the database refusing overlap, deletion, rewrites and invalid transitions |
| `tests/browser/scheduling.spec.ts` (Chromium, real API and console) | Booking a call and a walk-in, then Dr M's calendar; two receptionists choosing the same time; check-in, move and cancel; booking a referral; the doctor confined to his calendar; read-only without names                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Known limitations

- **No patient link to DTM.** Telephone and walk-in patients are not linked
  to a DTM file automatically. Reception does that in DTM, and nothing flows
  between the systems.
- **Bookings cannot be edited.** A patient's details cannot be corrected on
  an existing appointment: cancel and rebook.
- **Template changes are not retroactive.** New working hours apply to new
  bookings only. Existing appointments outside the new hours are not flagged.
- **One kind of booking.** There are no appointment types, rooms,
  equipment, buffers, holds, waitlists, reminders or patient self-booking.
- **No read audit.** Calendar reads are not audited. Writes are, in the
  appointment history and the audit log for configuration.
- **Times are SAST.** Time-zone handling is exercised for
  Africa/Johannesburg, which has no daylight saving. Zones with daylight
  saving use PostgreSQL's conversion but are untested.
- **No admin screen.** Practitioners are set up through the API or the seed.
