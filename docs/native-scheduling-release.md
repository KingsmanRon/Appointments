# Native scheduling: release readiness

This page covers the review of PR #11, the merge order for PRs #10 and #11,
what DTM PR #128 does in production, the staging acceptance checklist, and
what still blocks real patient data. Nothing here has been executed against
production.

## 1. Review findings

These areas were reviewed:

- practitioner isolation;
- access auditing;
- concurrency;
- cancellation and rescheduling;
- idempotency;
- logging and caching;
- rollback.

| ID  | Severity         | Finding                                                                                                                                                                     | Status                                                                                                                                                       |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | P1               | Opening a calendar or an appointment, which shows patient names, was not access-logged. DTM logs patient-record views; POPIA access accountability expects the same         | **Fixed.** `schedule.calendar.view` and `schedule.appointment.view` rows in `access_audit_log`, with no patient details. Refused reads write nothing. Tested |
| R2  | P1               | API answers carrying patient details had no `Cache-Control`, so a shared reception computer could keep calendars in its browser cache                                       | **Fixed.** Every `/v1` response is `no-store`. Tested                                                                                                        |
| R3  | P1               | The console never signed out. Reception desks are shared and show names and phone numbers. This was a gap in the whole console, not only in scheduling                      | **Fixed.** Signs out after 15 idle minutes across tabs (`VITE_IDLE_MINUTES`) and shows why. Browser-tested with a fake clock                                 |
| R4  | P1 (operational) | Rolling the application back to a build before #11 while `PRACTITIONER` memberships exist makes that build fail (500) for those users: its role table has no entry for them | **Mitigated.** New code fails closed for unknown roles. The rollback procedure (section 5.8) suspends `PRACTITIONER` memberships first                       |
| R5  | P2               | Check-in is accepted on any day, so a patient could be checked in for tomorrow by mistake                                                                                   | Open, optional                                                                                                                                               |
| R6  | P2               | A PostgreSQL deadlock or serialisation failure surfaces as 500. The console then resends the same `command_id`, which is safe; the API could return a clearer "retry" code  | Open, optional                                                                                                                                               |
| R7  | P2               | There is no API to deactivate or relink a practitioner (for example, when a doctor leaves)                                                                                  | Open, optional before go-live; a DBA can do it meanwhile                                                                                                     |

### Reviewed with no defect found

**Practitioner isolation.** A `PRACTITIONER` resolves only to the practitioner
linked to their verified actor (`user:<JWT subject>`). Asking for any other
practitioner or appointment answers 404. Restrictive row-level security on
`app.actor_id` applies the same rule inside PostgreSQL. It is tested through
the API and directly in SQL.

A practitioner has none of these permissions:

- `case.read`, `referral.ingest`, `metrics.read`, `rule_set.read`;
- booking, changing, or configuring.

The worker login has no privileges on the scheduling tables.

**Concurrency.**

- The exclusion constraint decides overlapping bookings (tested with ten
  simultaneous requests, staggered overlaps, and a reschedule racing a
  booking).
- Configuration takes the practitioner row `FOR UPDATE` and bookings take it
  `FOR SHARE`. A new block racing a booking never lets both succeed (tested,
  five rounds).
- Lock order is consistent (appointment → practitioner → referral case), so
  no deadlock cycle was found.

**Cancellation and rescheduling.**

- Both are versioned (`expected_version`) and follow the state machine in
  SQL and TypeScript.
- A reschedule writes the replacement and closes the original atomically. A
  refused new time leaves the original untouched (tested).
- Cancelling a referral appointment raises the booked referral for manager
  review.

**Idempotency.** One result per `command_id`, and a conflicting reuse is
refused. Stored results never contain patient details.

**Logging.** Only allow-listed fields are logged. A static test checks every
call site.

**Tenancy.** Another organisation's practitioner answers 404.

## 2. Dependency chain: PR #10 → PR #11 (not executed)

| Fact                        | Value                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| #10                         | `claude/amazing-dijkstra-gm98bm` → `main`; open, mergeable (`clean`), CI green                                                  |
| #11                         | `feat/native-scheduling-dr-m` → `claude/amazing-dijkstra-gm98bm` (stacked); draft, mergeable (`clean`), CI green                |
| #11 branched from           | `44f2f48`, which is #10's head; #11 contains all of #10                                                                         |
| `delete_branch_on_merge`    | `false`: GitHub will **not** retarget #11 automatically                                                                         |
| Merge methods allowed       | merge commit, squash and rebase. History so far uses merge commits                                                              |
| Effect of a merge to `main` | Vercel production deploy of the console, plus an `access-staging` deployment (both appear in the deployment history for `main`) |
| Branch protection           | Not readable with this token; check in repository settings                                                                      |

**Safe procedure:**

1. Review #10. Merge it with **Create a merge commit**.
   - Do not squash or rebase. Either would give #10's commits new identities,
     and #11 would then show #10's changes again against `main`.
   - #10 needs no migration. The DTM connector stays off unless
     `CONNECTOR_KIND=dtm` is set, and the worker refuses it with real data.
2. Keep `claude/amazing-dijkstra-gm98bm` until step 3 is done.
3. On #11, choose **Edit** and change the base to `main`. Check that
   **Files changed** lists only the scheduling work (migration `0007`,
   scheduling API, console, tests, docs). Let CI run on the new base.
4. If #10 gains commits before it merges, **merge** (do not rebase) its
   branch into `feat/native-scheduling-dr-m`.
5. Keep #11 in draft until the staging acceptance in section 5 is signed off.
6. When #11 is approved:
   1. apply `0007` to staging;
   2. merge #11 with a merge commit;
   3. in production, run the migration job **before** the new API revision
      takes traffic (`infra/azure/deploy.sh` runs the job first).
7. Delete `claude/amazing-dijkstra-gm98bm` only after #11 has been
   retargeted or merged.

## 3. DTM PR #128: deployment target and implications

| Fact                                                                 | Evidence                                                                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target `claude/patient-onboarding-pwa-PFlAh` is DTM's default branch | `GET /repos/KingsmanRon/dtm-inc` → `default_branch`                                                                                                     |
| That branch **is production**                                        | Its tip `f227423` is the latest Vercel _Production_ deployment, and DTM's release-gate workflow says so. Merging #128 deploys to production immediately |
| Migrations are applied by hand                                       | `scripts/run-migrations.mjs` and the README: `supabase db push` or `psql`, never by the deploy                                                          |
| Supabase GitHub auto-migration                                       | **Unverified.** Nothing in the repository enables it; check the Supabase dashboard (Integrations → GitHub) before merging                               |

**If #128 were merged before `0062` and `0063` are applied:**

- doctors and staff see a "Referral inbox" link to an empty list;
- inbox detail pages answer 404;
- the integration API answers 503 because its keys are unset.

No data would be harmed, but a broken feature would be live.

**Safe order:**

1. Apply `0062`, then `0063`, to a DTM staging copy, and run
   `supabase test db` there.
2. Apply both to production with a person present.
3. Merge #128 with `ACCESS_INTEGRATION_*` unset.
4. Enable the integration only after ACCESS's DTM connector passes
   qualification in synthetic mode.

**Rollback:** revert the merge commit on the production branch, and Vercel
redeploys. The inbox tables are additive and can stay.

#11 does not depend on #128, and #10 does not require it.

## 4. Release blockers and optional improvements

### Blockers before any real patient data

| #   | Blocker                                                                                                                                                   | Owner                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| B1  | ACCESS client-pilot checklist complete with evidence ([client-pilot-checklist.md](client-pilot-checklist.md))                                             | Product, security, privacy  |
| B2  | Retention period for appointment records agreed, and a deletion procedure written. ACCESS has no purge job, for appointments or for referrals             | Privacy owner, the practice |
| B3  | Privacy notice and operator agreement cover appointment booking data held in ACCESS (names, dates of birth, phone numbers, ID numbers)                    | Privacy owner, the practice |
| B4  | Staging acceptance (section 5) signed off, including the restore and rollback drills                                                                      | Product, operations         |
| B5  | Dr M's production identity: a Supabase user with MFA, a `PRACTITIONER` membership and a linked practitioner record, verified to see only his own calendar | Admin                       |
| B6  | #10 merged and #11 retargeted to `main` with CI green (section 2)                                                                                         | Engineering                 |
| B7  | PITR and backups confirmed to include the scheduling tables, with a tested restore and recorded RPO/RTO                                                   | Operations                  |

### Optional improvements (not blockers)

- **Check-in window (R5).** Accept check-in only on the appointment's day.
- **Retry code (R6).** Report deadlocks and serialisation failures as a
  "retry" code instead of 500.
- **Practitioner lifecycle (R7).** An API to deactivate or relink a
  practitioner.
- **Editable bookings.** Correct a booking's patient details without
  cancelling it.
- **Template changes.** Flag existing appointments that fall outside new
  working hours.
- **Per-patient read audit.** Today a view records the range.
- **Daylight saving.** Test zones with daylight saving.
- **Booking features.** Appointment types, reminders, and an admin screen
  for practitioners.

## 5. Isolated staging acceptance checklist

### 5.1 Environment

- [ ] A separate staging stack: its own Supabase project and database, the
      ACCESS API, worker and console, and a DTM staging copy.
      No production credentials, no production data, no production DNS.
- [ ] `ACCESS_DEPLOYMENT_PROFILE=synthetic-staging`,
      `ACCESS_DATA_MODE=SYNTHETIC`, `CONNECTOR_KIND=dtm` pointing at the DTM
      staging copy (synthetic mode), `VITE_IDLE_MINUTES=15`.
- [ ] Migrations `0001`–`0007` applied by the migration job. The API and
      worker start (identity checks pass).
- [ ] Synthetic users created: reception (`REFERRAL_COORDINATOR`), a
      manager, read-only staff, and Dr M (`PRACTITIONER`, linked to his
      practitioner record). All use MFA.

### 5.2 Reception workflows

- [ ] Book a telephone call with no referral; the phone number is required.
- [ ] Book a walk-in with no referral, using "next free time".
- [ ] Book a ready referral. The patient's details come from the referral,
      the referral shows `BOOKED`, and it leaves the "ready" list.
- [ ] Two receptionists on two computers choose the same time: one booking,
      and the other is told the time is taken.
- [ ] Move an appointment (the old time frees up) and move it into a taken
      time (refused, original unchanged).
- [ ] Cancel, check in, record did-not-attend (only after the start time),
      and record a late arrival.
- [ ] A manager blocks time (bookings refused there), and cannot block over
      an existing booking.
- [ ] Leave the console idle for 15 minutes: it signs out and says why.

### 5.3 Dr M's login and calendar

- [ ] Dr M signs in (MFA) and lands on his calendar; it is his only page.
- [ ] Day and week views show reception's bookings with statuses; blocks
      and lunch are shaded.
- [ ] He sees name, date of birth and reason, but no phone number or ID.
- [ ] He marks a checked-in patient as seen.
- [ ] Typing `#/book`, `#/queue`, or another practitioner's id (API) gives
      no access (redirect or 404).
- [ ] `access_audit_log` shows his calendar and appointment views, with no
      patient details in the payload.

### 5.4 Referral integration (ACCESS ↔ DTM staging)

- [ ] A synthetic referral is delivered to DTM staging's inbox, and its
      reference is recorded in ACCESS.
- [ ] DTM reception links it to a synthetic patient file.
- [ ] ACCESS reception books it natively; the ACCESS referral shows
      `BOOKED`.
- [ ] Integration refusals return the expected codes and are audited in
      DTM: wrong key, wrong data mode, and a duplicate delivery
      (de-duplicated).
- [ ] With the DTM integration switched off (keys unset), ACCESS raises a
      work item and nothing is lost.

### 5.5 Security spot checks

- [ ] `Cache-Control: no-store` on calendar responses (browser dev tools).
- [ ] Read-only staff see calendars without names.
- [ ] Another organisation's user sees nothing.
- [ ] Logs contain no names, dates of birth, phone numbers or ID numbers
      (sample a day of logs).

### 5.6 Backups

- [ ] PITR is enabled. Note the time T, then create and change appointments
      after T.

### 5.7 Restoration

- [ ] Restore to time T into a new isolated project.
- [ ] Run the migrations (no-op), then start the API against the restore.
- [ ] Appointments, history and audit rows match T.
- [ ] The overlap constraint still holds:
      `SELECT … WHERE occupied && …` returns no overlapping live pairs.
- [ ] Record the RPO and RTO.

### 5.8 Rollback

1. [ ] Suspend every `PRACTITIONER` membership.
2. [ ] Deploy the previous build (#10) against the migrated database.
3. [ ] Confirm that referrals and the queue work. The scheduling tables stay
       and are unused.
4. [ ] Redeploy #11 and reactivate the memberships.
5. [ ] Confirm the calendar is intact.
6. [ ] Write down the database rollback decision: `0007` is additive and is
       left in place. Removing it means restoring a backup taken before
       `0007`.

### 5.9 Sign-off

- [ ] Product owner, practice (reception lead and Dr M), security and
      privacy sign off. Evidence is linked in the release record.
