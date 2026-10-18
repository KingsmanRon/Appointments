-- 0007: native scheduling. ACCESS keeps the practice's own appointment book:
-- practitioners, weekly working hours, blocked periods and appointments
-- booked by reception (telephone, walk-in or referral). Applied by the
-- ledger runner inside one transaction with its schema_migrations row.
--
-- Additive only. The referral pipeline, the DTM connector tables and the
-- connector-based appointment operations (0006) are untouched. Patient
-- records stay in DTM: an appointment carries only what reception needs to
-- book and recognise the patient.
--
-- The invariant: a practitioner's time is never double booked. PostgreSQL
-- enforces it with an exclusion constraint, whatever the application does.

-- ---------------------------------------------------------------------------
-- 1. Practitioner role: a doctor who reads their own calendar.
-- ---------------------------------------------------------------------------

ALTER TABLE organisation_memberships DROP CONSTRAINT organisation_memberships_role_check;
ALTER TABLE organisation_memberships ADD CONSTRAINT organisation_memberships_role_check
  CHECK (role IN ('ADMIN','PRACTICE_MANAGER','REFERRAL_COORDINATOR','READ_ONLY','PRACTITIONER'));

-- ---------------------------------------------------------------------------
-- 2. Practitioners, working hours and blocked periods.
-- ---------------------------------------------------------------------------

CREATE TABLE practitioners(
  tenant_id uuid NOT NULL REFERENCES organisations(id),
  id uuid NOT NULL,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 120),
  -- The workforce actor who is this practitioner: user:<verified JWT subject>
  -- (synthetic:<user> with the development bridge). A PRACTITIONER session
  -- with that actor sees this practitioner's calendar and nothing else.
  linked_actor_id text CHECK (linked_actor_id IS NULL OR linked_actor_id ~ '^(user|synthetic):[A-Za-z0-9_.:-]{1,190}$'),
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  slot_minutes integer NOT NULL DEFAULT 15 CHECK (slot_minutes IN (5,10,15,20,30,60)),
  default_duration_minutes integer NOT NULL DEFAULT 15 CHECK (default_duration_minutes BETWEEN 5 AND 240),
  active boolean NOT NULL DEFAULT true,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, linked_actor_id)
);

-- An unknown time zone name is refused, not stored.
CREATE OR REPLACE FUNCTION practitioner_timezone_valid() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM now() AT TIME ZONE NEW.timezone;
  RETURN NEW;
END $$;
CREATE TRIGGER practitioners_timezone_valid BEFORE INSERT OR UPDATE OF timezone ON practitioners
  FOR EACH ROW EXECUTE FUNCTION practitioner_timezone_valid();

CREATE TABLE practitioner_working_hours(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  practitioner_id uuid NOT NULL,
  -- ISO weekday, 1 = Monday, in the practitioner's time zone.
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  minutes int4range GENERATED ALWAYS AS (int4range(start_minute, end_minute)) STORED,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A replaced template is retired, never deleted: the history stays.
  removed_at timestamptz,
  removed_by text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioners(tenant_id, id),
  CONSTRAINT working_hours_times CHECK (end_minute > start_minute),
  CONSTRAINT working_hours_removal CHECK ((removed_at IS NULL) = (removed_by IS NULL)),
  -- Current sessions on one day never overlap (lunch is two sessions).
  CONSTRAINT working_hours_no_overlap EXCLUDE USING gist (
    tenant_id WITH =, practitioner_id WITH =, weekday WITH =, minutes WITH &&) WHERE (removed_at IS NULL)
);

CREATE TABLE practitioner_blocks(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  reason_code text NOT NULL CHECK (reason_code IN ('LEAVE','ADMIN','MEETING','BREAK','PERSONAL','PUBLIC_HOLIDAY','OTHER')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  period tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  -- Administrative only; never clinical.
  note text CHECK (note IS NULL OR length(note) <= 200),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  removed_by text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioners(tenant_id, id),
  CONSTRAINT block_times CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '400 days'),
  CONSTRAINT block_removal CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
CREATE INDEX practitioner_blocks_period ON practitioner_blocks
  USING gist (tenant_id, practitioner_id, period) WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Appointments.
-- ---------------------------------------------------------------------------

CREATE TABLE scheduled_appointments(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  practitioner_id uuid NOT NULL,
  booking_channel text NOT NULL CHECK (booking_channel IN ('TELEPHONE','WALK_IN','REFERRAL')),
  -- The ACCESS referral this appointment books (REFERRAL channel only).
  referral_case_id uuid,
  -- What reception needs to recognise the patient. DTM holds the record.
  patient_given_name text NOT NULL CHECK (length(btrim(patient_given_name)) BETWEEN 1 AND 200),
  patient_family_name text NOT NULL CHECK (length(btrim(patient_family_name)) BETWEEN 1 AND 200),
  patient_date_of_birth date,
  patient_phone text CHECK (patient_phone IS NULL OR patient_phone ~ '^\+?[0-9 ()-]{6,24}$'),
  patient_identifier text CHECK (patient_identifier IS NULL OR length(patient_identifier) BETWEEN 1 AND 100),
  -- Administrative reason for the visit; never interpreted.
  reason text CHECK (reason IS NULL OR length(reason) <= 500),
  status text NOT NULL CHECK (status IN ('BOOKED','CHECKED_IN','COMPLETED','CANCELLED','NO_SHOW','RESCHEDULED')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 240),
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  occupied tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, ends_at, '[)')) STORED,
  booked_by text NOT NULL,
  booked_role text NOT NULL,
  rescheduled_from_id uuid,
  rescheduled_to_id uuid,
  rescheduled_at timestamptz,
  rescheduled_by text,
  checked_in_at timestamptz,
  checked_in_by text,
  completed_at timestamptz,
  completed_by text,
  no_show_at timestamptz,
  no_show_by text,
  cancelled_at timestamptz,
  cancelled_by text,
  cancellation_reason_code text CHECK (cancellation_reason_code IS NULL OR cancellation_reason_code IN
    ('PATIENT_REQUEST','PRACTICE_REQUEST','PRACTITIONER_UNAVAILABLE','DUPLICATE_BOOKING','OTHER')),
  cancellation_note text CHECK (cancellation_note IS NULL OR length(cancellation_note) <= 500),
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, practitioner_id) REFERENCES practitioners(tenant_id, id),
  FOREIGN KEY (tenant_id, referral_case_id, booking_channel) REFERENCES access_cases(tenant_id, id, case_type)
    DEFERRABLE INITIALLY DEFERRED,
  -- A reschedule writes the replacement and closes the original in one
  -- transaction; the links are checked at commit.
  FOREIGN KEY (tenant_id, rescheduled_from_id) REFERENCES scheduled_appointments(tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (tenant_id, rescheduled_to_id) REFERENCES scheduled_appointments(tenant_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT appointment_referral_channel CHECK ((booking_channel = 'REFERRAL') = (referral_case_id IS NOT NULL)),
  CONSTRAINT appointment_times CHECK (ends_at - starts_at = make_interval(mins => duration_minutes)),
  CONSTRAINT appointment_not_self_linked CHECK (rescheduled_from_id IS DISTINCT FROM id AND rescheduled_to_id IS DISTINCT FROM id),
  CONSTRAINT appointment_checked_in_complete CHECK (
    status NOT IN ('CHECKED_IN','COMPLETED') OR (checked_in_at IS NOT NULL AND checked_in_by IS NOT NULL)),
  CONSTRAINT appointment_completed_complete CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL AND completed_by IS NOT NULL)),
  CONSTRAINT appointment_no_show_complete CHECK (status <> 'NO_SHOW' OR (no_show_at IS NOT NULL AND no_show_by IS NOT NULL)),
  CONSTRAINT appointment_cancelled_complete CHECK (
    (status = 'CANCELLED') = (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL AND cancellation_reason_code IS NOT NULL)),
  CONSTRAINT appointment_rescheduled_complete CHECK (
    (status = 'RESCHEDULED') = (rescheduled_to_id IS NOT NULL AND rescheduled_at IS NOT NULL AND rescheduled_by IS NOT NULL)),
  -- THE invariant: a practitioner's booked time never overlaps.
  CONSTRAINT appointments_no_practitioner_overlap EXCLUDE USING gist (
    tenant_id WITH =, practitioner_id WITH =, occupied WITH &&
  ) WHERE (status IN ('BOOKED','CHECKED_IN','COMPLETED'))
);
-- The REFERRAL channel binds to a REFERRAL case: the composite foreign key
-- above compares booking_channel with case_type, so both must read REFERRAL.
CREATE INDEX scheduled_appointments_practitioner_start ON scheduled_appointments(tenant_id, practitioner_id, starts_at);
CREATE INDEX scheduled_appointments_referral ON scheduled_appointments(tenant_id, referral_case_id)
  WHERE referral_case_id IS NOT NULL;
-- A referral has at most one live appointment.
CREATE UNIQUE INDEX scheduled_appointments_one_live_per_referral ON scheduled_appointments(tenant_id, referral_case_id)
  WHERE referral_case_id IS NOT NULL AND status IN ('BOOKED','CHECKED_IN');
-- An appointment has at most one replacement.
CREATE UNIQUE INDEX scheduled_appointments_one_replacement ON scheduled_appointments(tenant_id, rescheduled_from_id)
  WHERE rescheduled_from_id IS NOT NULL;

-- Explicit state machine (mirrors packages/domain SCHEDULE_TRANSITIONS).
-- NO_SHOW -> CHECKED_IN records a late arrival: it re-occupies the time and
-- therefore fails if that time was booked again meanwhile.
CREATE OR REPLACE FUNCTION scheduled_appointment_transition_allowed(from_status text, to_status text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (from_status, to_status) IN (
    ('BOOKED','CHECKED_IN'), ('BOOKED','CANCELLED'), ('BOOKED','NO_SHOW'), ('BOOKED','RESCHEDULED'),
    ('CHECKED_IN','COMPLETED'), ('CHECKED_IN','CANCELLED'),
    ('NO_SHOW','CHECKED_IN'))
$$;

CREATE OR REPLACE FUNCTION scheduled_appointment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'appointments are never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'BOOKED' THEN
      RAISE EXCEPTION 'an appointment is created BOOKED, not %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.version := 0;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  -- What was booked never changes: a new time is a new appointment.
  IF ROW(NEW.tenant_id, NEW.id, NEW.practitioner_id, NEW.booking_channel, NEW.referral_case_id,
         NEW.patient_given_name, NEW.patient_family_name, NEW.patient_date_of_birth, NEW.patient_phone,
         NEW.patient_identifier, NEW.reason, NEW.starts_at, NEW.ends_at, NEW.duration_minutes, NEW.timezone,
         NEW.booked_by, NEW.booked_role, NEW.rescheduled_from_id, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.tenant_id, OLD.id, OLD.practitioner_id, OLD.booking_channel, OLD.referral_case_id,
         OLD.patient_given_name, OLD.patient_family_name, OLD.patient_date_of_birth, OLD.patient_phone,
         OLD.patient_identifier, OLD.reason, OLD.starts_at, OLD.ends_at, OLD.duration_minutes, OLD.timezone,
         OLD.booked_by, OLD.booked_role, OLD.rescheduled_from_id, OLD.created_at) THEN
    RAISE EXCEPTION 'booked details of an appointment are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT scheduled_appointment_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'invalid appointment transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'appointment version must advance by one' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER scheduled_appointments_guard BEFORE INSERT OR UPDATE OR DELETE ON scheduled_appointments
  FOR EACH ROW EXECUTE FUNCTION scheduled_appointment_guard();

-- Append-only history of every booking decision. No patient details.
CREATE TABLE scheduled_appointment_events(
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('BOOKED','RESCHEDULED','CANCELLED','CHECKED_IN','COMPLETED','NO_SHOW')),
  from_status text,
  to_status text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  related_appointment_id uuid,
  reason_code text,
  actor_id text NOT NULL,
  actor_role text NOT NULL,
  command_id uuid NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES scheduled_appointments(tenant_id, id)
);
CREATE INDEX scheduled_appointment_events_appointment ON scheduled_appointment_events(tenant_id, appointment_id, occurred_at);
CREATE TRIGGER scheduled_appointment_events_append_only BEFORE UPDATE OR DELETE ON scheduled_appointment_events
  FOR EACH ROW EXECUTE FUNCTION access_forbid_mutation();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['scheduled_appointments','scheduled_appointment_events'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION access_forbid_mutation()',
                   t || '_no_truncate', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Row-level security and least privilege.
-- ---------------------------------------------------------------------------

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['practitioners','practitioner_working_hours','practitioner_blocks',
                           'scheduled_appointments','scheduled_appointment_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON %I FROM authenticated', t);
    END IF;
  END LOOP;
END $$;

-- A PRACTITIONER session sees its own practitioner, calendar and history,
-- and nobody else's, even if the application asked for more. Restrictive
-- policies are ANDed with tenant isolation.
CREATE OR REPLACE FUNCTION scheduling_session_practitioner(p_tenant uuid, p_practitioner uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT current_setting('app.actor_role', true) IS DISTINCT FROM 'PRACTITIONER'
      OR EXISTS (SELECT 1 FROM practitioners p
                  WHERE p.tenant_id = p_tenant AND p.id = p_practitioner
                    AND p.linked_actor_id = nullif(current_setting('app.actor_id', true), ''))
$$;
CREATE POLICY practitioner_self_only ON practitioners AS RESTRICTIVE
  USING (current_setting('app.actor_role', true) IS DISTINCT FROM 'PRACTITIONER'
         OR linked_actor_id = nullif(current_setting('app.actor_id', true), ''));
CREATE POLICY practitioner_own_hours ON practitioner_working_hours AS RESTRICTIVE
  USING (scheduling_session_practitioner(tenant_id, practitioner_id));
CREATE POLICY practitioner_own_blocks ON practitioner_blocks AS RESTRICTIVE
  USING (scheduling_session_practitioner(tenant_id, practitioner_id));
CREATE POLICY practitioner_own_calendar ON scheduled_appointments AS RESTRICTIVE
  USING (scheduling_session_practitioner(tenant_id, practitioner_id));
CREATE POLICY practitioner_own_history ON scheduled_appointment_events AS RESTRICTIVE
  USING (current_setting('app.actor_role', true) IS DISTINCT FROM 'PRACTITIONER'
         OR EXISTS (SELECT 1 FROM scheduled_appointments a
                     WHERE a.tenant_id = scheduled_appointment_events.tenant_id
                       AND a.id = scheduled_appointment_events.appointment_id));

-- API (access_request) only. The worker has no business with the book.
GRANT SELECT, INSERT, UPDATE ON practitioners TO access_request;
-- No runtime role deletes anything: replaced hours and removed blocks are
-- retired with removed_at.
GRANT SELECT, INSERT ON practitioner_working_hours TO access_request;
GRANT UPDATE (removed_at, removed_by) ON practitioner_working_hours TO access_request;
GRANT SELECT, INSERT ON practitioner_blocks TO access_request;
GRANT UPDATE (removed_at, removed_by) ON practitioner_blocks TO access_request;
GRANT SELECT, INSERT ON scheduled_appointments TO access_request;
GRANT UPDATE (status, rescheduled_to_id, rescheduled_at, rescheduled_by, checked_in_at, checked_in_by,
              completed_at, completed_by, no_show_at, no_show_by, cancelled_at, cancelled_by,
              cancellation_reason_code, cancellation_note, version, updated_at)
  ON scheduled_appointments TO access_request;
GRANT SELECT, INSERT ON scheduled_appointment_events TO access_request;
