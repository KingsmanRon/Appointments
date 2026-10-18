# Native scheduling: release readiness

This page covers:

- the review of PR #11;
- the merge order for PRs #10 and #11;
- what DTM PR #128 does in production;
- what was verified locally and what still needs hosted staging;
- the deployment and rollback procedures;
- what still blocks real patient data.

Nothing here has been executed against production. Last verified on
18 October 2026.

## 1. Review findings

These areas were reviewed:

- practitioner isolation;
- access auditing;
- concurrency;
- cancellation and rescheduling;
- idempotency;
- logging and caching;
- rollback, restore, database restarts and retention.

| ID  | Severity         | Finding                                                                                                                                                                          | Status                                                                                                                                                                                   |
| --- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | P1               | Opening a calendar or an appointment, which shows patient names, was not access-logged. DTM logs patient-record views; POPIA access accountability expects the same              | **Fixed.** `schedule.calendar.view` and `schedule.appointment.view` rows in `access_audit_log`, with no patient details. Refused reads write nothing. Tested                             |
| R2  | P1               | API answers carrying patient details had no `Cache-Control`, so a shared reception computer could keep calendars in its browser cache                                            | **Fixed.** Every `/v1` response is `no-store`. Tested                                                                                                                                    |
| R3  | P1               | The console never signed out. Reception desks are shared and show names and phone numbers. This was a gap in the whole console, not only in scheduling                           | **Fixed.** Signs out after 15 idle minutes across tabs (`VITE_IDLE_MINUTES`) and shows why. Browser-tested with a fake clock                                                             |
| R4  | P1 (operational) | Rolling back to a build before #11 while a `PRACTITIONER` membership is active: that build answers 500 on that user's permission-checked requests (rehearsed: `/v1/cases` → 500) | **Mitigated.** New code fails closed for unknown roles. Rollback suspends `PRACTITIONER` memberships first, **on #11** (see R9)                                                          |
| R5  | P2               | Check-in is accepted on any day, so a patient could be checked in for tomorrow by mistake                                                                                        | Open, optional                                                                                                                                                                           |
| R6  | P2               | A PostgreSQL deadlock or serialisation failure surfaces as 500. The console then resends the same `command_id`, which is safe; the API could return a clearer "retry" code       | Open, optional                                                                                                                                                                           |
| R7  | P2               | There is no API to deactivate or relink a practitioner (for example, when a doctor leaves)                                                                                       | Open, optional. Suspending the membership removes access meanwhile                                                                                                                       |
| R8  | P1 (operational) | The #10 image's migration runner exits 1 on a database with `0007` (`applied migration 0007_native_scheduling is missing`). `infra/azure/deploy.sh` runs it during every deploy  | **Procedure fixed.** Roll back by changing the API and worker images only, never through `deploy.sh` (section 6.3). Reproduced locally                                                   |
| R9  | P1 (operational) | The #10 build's admin API rejects a `PRACTITIONER` membership (400), so the old rollback order ("suspend, then deploy #10") could not be done through the API after rollback     | **Procedure fixed.** Suspend on #11, then roll back (section 6.3). Rehearsed                                                                                                             |
| R10 | P1               | A database restart or failover crashed the API and the worker (`Unhandled 'error' event` from an idle pooled connection). Platform-wide, older than #11                          | **Fixed.** The pool always listens and the next query reconnects; API and worker log it. Regression test, and a rehearsal shows the API stays up and answers `/ready` 503, then recovers |
| R11 | P1               | Appointment records could not be deleted by any role, owner included (guard triggers), so no retention period could be honoured                                                  | **Fixed.** Operator purge `npm run schedule:purge` (dry run by default, whole finished chains only, audited). Tested. The period itself is the practice's decision (B2)                  |
| R12 | P1 (real data)   | ACCESS does not enforce multi-factor authentication. The API ignores the token's `aal` claim and the console has no MFA step, so B5's "user with MFA" cannot be enforced         | **Open: blocker B8.** Needs console enrolment and challenge plus API `aal2` enforcement. It is platform-wide (referral data too)                                                         |
| R13 | P2 (operational) | A data-only restore into a migrated database fails (guard triggers and foreign-key order). Without `--single-transaction` it would leave a partial copy                          | **Procedure.** Use PITR, or a full restore into an empty database with `--single-transaction` (section 6.4). Rehearsed                                                                   |
| R14 | P2 (operational) | `infra/azure/deploy.sh` updates the container revisions before it runs the migration job, so a new API can serve before its migration lands                                      | **Procedure.** Apply `0007` before deploying the #11 image; it is compatible with the running build (section 3). Before `0007`, #11 still serves referrals, but scheduling answers 500   |

### Reviewed with no defect found

**Practitioner isolation.** A `PRACTITIONER` resolves only to the practitioner
linked to their verified actor (`user:<JWT subject>`). Asking for any other
practitioner or appointment answers 404. Restrictive row-level security on
`app.actor_id` applies the same rule inside PostgreSQL. It is tested through
the API and directly in SQL, and it holds on a restored copy.

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
refused. Stored results never contain patient details. A booking resent
after a database outage, or after the client abandoned the request, creates
exactly one appointment (rehearsed).

**Logging.** Only allow-listed fields are logged. A static test checks every
call site.

**Tenancy.** Another organisation's practitioner answers 404.

## 2. Dependency chain: PR #10 → PR #11

| Fact                        | Value (18 October 2026)                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| #10                         | `claude/amazing-dijkstra-gm98bm` @ `44f2f48` → `main` @ `5a82d96`; **open, not merged**, mergeable, CI green               |
| #11                         | `feat/native-scheduling-dr-m` → `claude/amazing-dijkstra-gm98bm` (stacked); draft, contains all of #10                     |
| #11's diff once #10 merges  | 46 files, all native scheduling: migration `0007` is its only migration; no worker, connector or DTM file                  |
| `delete_branch_on_merge`    | `false`: GitHub will **not** retarget #11 automatically                                                                    |
| Merge methods allowed       | merge commit, squash and rebase. History so far uses merge commits                                                         |
| Effect of a merge to `main` | Vercel _Production_ (the console) and Railway project `access-staging`, environment `production` (API and worker) redeploy |
| Branch protection           | Not readable with this token; check in repository settings                                                                 |

**What merging #10 changes in the running systems (verified before the merge
was attempted):**

- **Console.** A console built from `main` and from `44f2f48` is
  byte-identical (14 of 14 files).
- **Database.** No migration.
- **Worker.** The DTM connector stays off unless `CONNECTOR_KIND=dtm` and
  three valid `DTM_*` settings are present. The running `main` refuses
  `CONNECTOR_KIND=dtm` at startup, so a working deployment cannot have it set.
- **Real data.** REAL data with `dtm` is refused in every profile, and REAL
  is refused in `synthetic-staging`.
- **DTM.** DTM production has no `/api/v1/integrations/access` route (it
  exists only on #128), so nothing can reach DTM production.

**Safe procedure:**

1. Merge #10 with **Create a merge commit**.
   - Do not squash or rebase. Either would give #10's commits new identities,
     and #11 would then show #10's changes again against `main`.
2. Keep `claude/amazing-dijkstra-gm98bm` until step 3 is done.
3. On #11, choose **Edit** and change the base to `main`. Check that
   **Files changed** lists the 46 scheduling files above. Let CI run on the
   new base.
4. If #10 gains commits before it merges, **merge** (do not rebase) its
   branch into `feat/native-scheduling-dr-m`.
5. Keep #11 in draft until the staging acceptance in section 7 is signed off.
6. Release #11 as described in section 6.2.
7. Delete `claude/amazing-dijkstra-gm98bm` only after #11 has been
   retargeted or merged.

## 3. Local verification (not a substitute for hosted staging)

These checks ran on local PostgreSQL 16 with synthetic data only. They show
the code, migration and procedures behave as designed. They do not show that
a hosted environment is configured correctly; section 4 covers that.

| Check                                       | Result                                                                                                                                                                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full gate on #11                            | format, lint, typecheck, build, secret check and static infra checks pass. Unit 138/138, PostgreSQL integration 153/153 with no skips, browser 6/6                                                                                                  |
| `0007` against the deployed code            | The integration suites of `5a82d96` (deployed `main`) and `44f2f48` (#10) pass against a database that includes `0007`: 111/116 and 118/123. The 5 failures in each are migration-count assertions only (the directory gained a file)               |
| `0007` upgrade of a populated database      | Database at `0006` filled by #10's full suite (all 20 tables have rows); `0007` applied in 44 ms; every pre-existing table byte-identical afterwards (only the ledger gained a row); rerun is a no-op                                               |
| #11 against a database **without** `0007`   | Starts; `/ready` 200; referral routes 200; scheduling routes 500. So `0007` must be applied before #11 serves                                                                                                                                       |
| Rollback #11 → #10 on the migrated database | 20/20 checks. Admin creates Dr M (membership, linked practitioner, hours); reception books; Dr M sees his calendar; suspend on #11; the #10 build serves reception; suspended Dr M gets 403; roll forward, reactivate, same appointments            |
| Rollback hazards (observed, then mitigated) | #10's migration runner exits 1 on the migrated database (R8). #10's admin API answers 400 for a `PRACTITIONER` membership (R9). An active `PRACTITIONER` on #10 gets 500, and the API stays healthy (R4)                                            |
| Database restart with the API running       | Before R10's fix: the API process exited. After: it stays up, `/ready` 503 and bookings refused during the outage, then recovers without a restart. The resent booking creates 1 row; a resend returns the same appointment                         |
| Abandoned request, then resend              | Resend 201, again 200 (same appointment), 1 row                                                                                                                                                                                                     |
| Full logical backup and restore             | `pg_dump -Fc` restored into an empty database and into a fresh cluster. Data byte-identical for all 20 tables; structure identical (213 constraints, 3 exclusion constraints, 29 triggers, 33 policies, 23 forced-RLS tables, all grants)           |
| Protections on the restored copy            | Overlapping booking refused by the exclusion constraint; owner `DELETE` refused by the guard; API login cannot delete; RLS: 0 rows without tenant context, 3 with it, 0 for an unlinked practitioner; migrations no-op; the API serves the calendar |
| Restore into a fresh cluster                | Without the runtime roles it fails cleanly (0 tables, single transaction). Creating `access_request` and `access_worker` first, then `runtime-roles.sql` after, gives an identical copy                                                             |
| Data-only restore into a migrated database  | Fails: the guard refuses `RESCHEDULED` rows, and foreign-key order breaks other tables. Use the procedure in section 6.4 instead (R13)                                                                                                              |
| Retention purge                             | Dry run counts and rolls back. Confirmed: only whole finished chains before the cutoff go; live chains, unresolved bookings and later bookings stay; the other organisation is untouched; audited with counts; the guards are back on               |

### Still needs hosted staging

Local runs cannot show any of these:

- PITR restore and the real RPO/RTO;
- Supabase Auth, JWKS and MFA;
- Railway and Vercel behaviour on deploy and rollback;
- TLS and `DATABASE_CA_CERT`;
- the runtime-role identity checks under `synthetic-staging`;
- Supabase Storage;
- the DTM staging integration end to end;
- people using the real console on reception computers.

## 4. Hosted environments

| Environment                                                 | What is known                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway project `access-staging` (environment `production`) | Deploys API and worker from `main` (last `5a82d96`, 26 September). The repository documents Railway as synthetic-staging only. Its variables, database and Supabase project could not be inspected: this session has no Railway, Vercel or Supabase credentials |
| Vercel `access-console` (_Production_)                      | Deploys the console from `main` (last `5a82d96`). The egress proxy blocks it from this session, so its health and `VITE_CORE_API_URL` are unverified                                                                                                            |
| A separate, isolated staging stack (section 7.1)            | **Not found.** No separate Supabase project, Railway service or Vercel project for staging is recorded in the repository or its deployment history                                                                                                              |
| DTM staging copy                                            | **Not found.** DTM has preview deployments, but none is recorded as using its own database                                                                                                                                                                      |

Hosted staging acceptance cannot start until someone with access decides
which environment is the isolated staging stack. If `access-staging` is that
stack, confirm it has its own Supabase project, auth, storage and secrets, and
that the Vercel _Production_ console is used only for synthetic staging.

## 5. DTM PR #128: deployment target and migration readiness

| Fact                                                                 | Evidence                                                                                                                                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target `claude/patient-onboarding-pwa-PFlAh` is DTM's default branch | `GET /repos/KingsmanRon/dtm-inc` → `default_branch`                                                                                                                        |
| That branch **is production**                                        | Its tip `f227423` (7 October) is the latest Vercel _Production_ deployment. DTM's release gate runs on pushes to it. Merging #128 deploys to production immediately        |
| #128 is current                                                      | `aa230f5`: 5 commits ahead of production, 0 behind; mergeable; release gate, pgTAP and MIME checks green                                                                   |
| Migrations are manual                                                | Nothing in the repository applies them to a hosted database: `build` is `next build`; the pgTAP workflow uses a throwaway local Supabase; `db:migrate` only prints the SQL |
| Supabase GitHub integration                                          | **Unverified.** `supabase/config.toml` has no branching settings, but only the Supabase dashboard (Integrations → GitHub) can confirm it is off                            |
| `0062` compatibility                                                 | Adds 5 `audit_action` enum values. The running app never uses them. Must be its own transaction (it is its own file)                                                       |
| `0063` compatibility                                                 | Additive: two guarded enum types, a sequence, a new RLS table and four new functions. It only refers to the existing `patient_referrals` table inside a new function       |
| Rehearsal                                                            | CI applies all migrations through `0063` on a fresh Supabase database and runs pgTAP: green. **Not rehearsed on a copy of the production schema**: there is no DTM staging |

**If #128 were merged before `0062` and `0063` are applied:**

- doctors and staff see a "Referral inbox" link to an empty list;
- inbox detail pages answer 404;
- the integration API answers 503 because its keys are unset.

No data would be harmed, but a broken feature would be live.

### 5.1 DTM production deployment runbook

1. **Staging rehearsal (required).**
   1. Restore a schema-only copy of production into an isolated Supabase
      project.
   2. Check that nothing already uses the new names:
      `\df *access_referral*` and `\dT access_*`. The functions use
      `CREATE OR REPLACE`, so a same-named function created outside the
      migrations would be silently replaced.
   3. Apply `0062`, then `0063`, separately. Run `supabase test db`.
   4. Deploy #128's preview against that project. Check the inbox,
      authentication, RLS (non-clinical roles see nothing) and audit rows.
      Keep `ACCESS_INTEGRATION_*` unset, and check that the API answers 503.
2. **Before production.**
   - Confirm in the Supabase dashboard that GitHub auto-migration is off.
   - Take a manual backup and note the PITR time.
3. **Production migration**, with a person present:
   1. apply `0062` alone;
   2. apply `0063` alone;
   3. run the step 1.2 checks against production.

   The running app is unaffected: both migrations are additive.

4. **Merge #128** with a merge commit. Leave `ACCESS_INTEGRATION_*` unset.
   Vercel deploys production.
5. **Verify production.**
   - Clinical staff see an empty inbox.
   - Non-clinical roles see no inbox.
   - The integration API answers 503.
   - No errors in the logs.
6. **Activation is a separate, approved change.** Set
   `ACCESS_INTEGRATION_*` only after ACCESS's DTM connector passes
   qualification against DTM staging in synthetic mode.

### 5.2 DTM rollback runbook

- **Application.** Redeploy the previous production deployment in Vercel
  (instant), or revert the merge commit on the production branch. Leave the
  integration keys unset.
- **Database.** Leave `0062` and `0063` in place. Both are additive, and the
  previous build ignores them. Enum values cannot be removed from PostgreSQL
  without rebuilding the type. If the inbox must go, restore from the backup
  taken in step 2 (it loses later writes); only after a decision.

#11 does not depend on #128, and #10 does not require it.

## 6. ACCESS deployment and rollback procedures

### 6.1 #10

Merge as in section 2. No migration. Afterwards, check:

- Vercel and Railway deployments succeed;
- `/health` reports the new `BUILD_ID`, and `/ready` answers 200;
- the worker log shows no configuration error (exit 78 would mean bad
  variables);
- the console loads.

**Rollback.** Revert the merge commit on `main`. The platforms redeploy
`5a82d96`.

### 6.2 #11 (after staging sign-off)

1. **Apply `0007` first,** using the #11 commit's runner, to each environment
   in turn (staging, then production):
   `MIGRATION_DATABASE_URL=… npm run db:migrate`. It is compatible with the
   running #10 build (section 3).
2. **Deploy.** On Railway and Vercel, merge #11 with a merge commit. On
   Azure, run `infra/azure/deploy.sh` with the #11 image digest; its migration
   job is then a no-op.
3. **Set up Dr M.**
   - The admin grants `PRACTITIONER` to his Supabase user
     (`POST /v1/admin/memberships`).
   - The admin creates his practitioner record with
     `linked_actor_id=user:<his Supabase user id>`
     (`POST /v1/schedule/practitioners`).
   - The admin sets his working hours.
4. **Verify.**
   - `/ready` answers 200.
   - Reception can book.
   - Dr M sees only his own calendar.
   - `access_audit_log` has view rows.

### 6.3 #11 rollback (rehearsed locally)

1. **On #11**, suspend every `PRACTITIONER` membership through the admin
   API. The #10 build cannot do this (R9).
2. **Change the images only.** Never run `deploy.sh` or the migration job
   with the #10 image: its runner refuses the migrated database (R8).
   - Railway or Vercel: redeploy the previous deployment, or revert the merge
     commit.
   - Azure:
     `az containerapp update -n "$PREFIX-api" -g "$RESOURCE_GROUP" --image "$PREVIOUS_IMAGE"`,
     and the same for `"$PREFIX-worker"`.
3. **Check.** Reception's queue and referrals work. Suspended practitioners
   get 403. The scheduling tables stay and are unused.
4. **Database.** Leave `0007` in place. Removing it means restoring a backup
   taken before `0007`.
5. **Roll forward.** Redeploy #11, then reactivate the memberships.

### 6.4 Restore

- **Preferred:** PITR into a new, isolated project.
- **Logical restore**, into an **empty** database only:
  1. create the `access_request` and `access_worker` roles (the two
     `CREATE ROLE` lines at the top of `0001`);
  2. `pg_restore --no-owner --single-transaction --exit-on-error`;
  3. `runtime-roles.sql` with new passwords;
  4. `npm run db:migrate` (no-op).
- **Never** run a data-only restore into a migrated database (R13).

### 6.5 Retention purge

See [runbooks.md](runbooks.md#retention-and-deletion). Run it only after the
practice has agreed the period (B2).

## 7. Release blockers before real patient data

| #   | Blocker                                                                                                | Type                     | Already satisfied (evidence)                                                                                                                | Outstanding                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| B1  | Client-pilot checklist complete with evidence ([client-pilot-checklist.md](client-pilot-checklist.md)) | Approval and operations  | The technical controls it lists exist and are tested: forced RLS, least-privilege logins, audit, logging allowlist, no-store, idle sign-out | Every item ticked, with evidence from the real environment; pen test, DPA and privacy sign-off                                       |
| B2  | Retention period agreed and deletion procedure                                                         | Client and privacy       | Deletion is now possible and tested: `npm run schedule:purge` (R11) and the runbook                                                         | The practice and privacy owner agree the period; the purge is scheduled operationally. Referral records still have no purge          |
| B3  | Privacy notice and operator agreement cover appointment data held in ACCESS                            | Client and privacy       | None (not a technical item)                                                                                                                 | Notice and agreement updated: names, dates of birth, phone numbers, ID numbers                                                       |
| B4  | Hosted staging acceptance signed off, including restore and rollback drills                            | Technical and operations | The procedures are rehearsed locally (section 3); the checklist is in section 8                                                             | An isolated staging stack (section 4), then every item in section 8 run there with evidence                                          |
| B5  | Dr M's production identity, verified to see only his own calendar                                      | Technical and admin      | The admin API creates the membership and linked practitioner; isolation tested and rehearsed                                                | His Supabase user is created; verified in staging, then production. MFA depends on B8                                                |
| B6  | #10 merged and #11 retargeted to `main` with CI green                                                  | Technical                | #10 verified safe to merge (section 2); #11's post-merge diff is scheduling-only                                                            | **#10 is not merged** (GitHub shows it open; `main` is still `5a82d96`). Then retarget #11 and rerun CI                              |
| B7  | Backups and PITR include the scheduling tables, with a tested restore and recorded RPO/RTO             | Technical and operations | Logical backup and restore of the scheduling tables proven locally, with all protections intact (section 3)                                 | PITR enabled on the real project; a timed PITR restore in staging; RPO and RTO recorded                                              |
| B8  | Multi-factor authentication enforced (R12)                                                             | Technical, then decision | None. Supabase Auth can hold factors, but ACCESS neither requires nor checks them                                                           | Console enrolment and challenge, API refusal of tokens without `aal2`, and a recovery procedure. Or a recorded decision to waive MFA |

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

## 8. Isolated staging acceptance checklist

Each item needs evidence in the release record: a screenshot with synthetic
data, a log extract or a query result.

### 8.1 Environment

- [ ] A separate staging stack: its own Supabase project (database, auth,
      storage), its own API, worker and console, and a DTM staging copy.
      No production credentials, no production data, no production DNS.
- [ ] `ACCESS_DEPLOYMENT_PROFILE=synthetic-staging`,
      `ACCESS_DATA_MODE=SYNTHETIC`, `CONNECTOR_KIND=dtm` pointing at the DTM
      staging copy (synthetic mode), `VITE_IDLE_MINUTES=15`.
- [ ] `0007` applied with the #11 runner while the #10 build is still
      running; that build keeps working. Then #11 is deployed. The API and
      worker start, and the identity checks pass.
- [ ] Synthetic users created: reception (`REFERRAL_COORDINATOR`), a
      manager, read-only staff, and Dr M (`PRACTITIONER`, linked to his
      practitioner record). MFA once B8 is done.

### 8.2 Reception workflows

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
- [ ] A manager blocks time for leave (bookings refused there), and cannot
      block over an existing booking.
- [ ] Leave the console idle for 15 minutes: it signs out and says why.

### 8.3 Dr M's login and calendar

- [ ] Dr M signs in and lands on his calendar; it is his only page.
- [ ] Day and week views show reception's bookings with statuses; blocks
      and lunch are shaded.
- [ ] He sees name, date of birth and reason, but no phone number or ID.
- [ ] He marks a checked-in patient as seen.
- [ ] Typing `#/book`, `#/queue`, or another practitioner's id (API) gives
      no access (redirect or 404).
- [ ] `access_audit_log` shows his calendar and appointment views, with no
      patient details in the payload.

### 8.4 Referral integration (ACCESS ↔ DTM staging)

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

### 8.5 Security and resilience spot checks

- [ ] `Cache-Control: no-store` on calendar responses (browser dev tools).
- [ ] Read-only staff see calendars without names.
- [ ] Another organisation's user sees nothing.
- [ ] Logs contain no names, dates of birth, phone numbers or ID numbers
      (sample a day of logs).
- [ ] Restart the staging database (or fail it over). The API and worker
      stay up, `/ready` recovers, and a booking resent with the same
      `command_id` creates one appointment.

### 8.6 Backups and restoration

- [ ] PITR is enabled. Note the time T, then create and change appointments
      after T.
- [ ] Restore to time T into a new isolated project. Run the migrations
      (no-op), then start the API against the restore.
- [ ] Appointments, history and audit rows match T. An overlapping booking
      is refused on the restore.
- [ ] Record the RPO and RTO.

### 8.7 Rollback

- [ ] Follow section 6.3 end to end. Record the time taken and that the
      calendar is intact after rolling forward.
- [ ] Run the retention purge dry run (section 6.5) and check its counts.

### 8.8 Sign-off

- [ ] Product owner, practice (reception lead and Dr M), security and
      privacy sign off. Evidence is linked in the release record.
