import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  OCCUPYING_STATUSES,
  type AnyExtraction,
  type BookAppointment,
  type BookingChannel,
  type FieldsPatch,
  type PractitionerCreate,
  type ScheduleChange,
  type ScheduleStatus,
  type StaffRole,
  type WorkingHoursInput,
} from "@access/contracts";
import {
  AppError,
  bookingReadiness,
  caseExecutions,
  conflict,
  evidence,
  executeCommand,
  executionInFlight,
  lockCase,
  notFound,
  recordObservation,
  requestHash,
  tenantTx,
  type DbClient,
  type Replayed,
} from "@access/db";
import {
  canScheduleTransition,
  scheduleChangeTarget,
  workingSessions,
} from "@access/domain";
import { log } from "@access/observability";
import { authorize, can, type Permission } from "@access/policy";
import { referralField, type ReferralFacts } from "@access/rules";
import type { AuthContext } from "./auth.js";
import { requestContext } from "./service.js";

/**
 * Native scheduling: ACCESS's own appointment book (migration 0007).
 *
 * Every command runs in one PostgreSQL transaction under the caller's tenant,
 * role and actor (so row-level security scopes a PRACTITIONER to their own
 * calendar), and at most once per command_id. The database has the last
 * word on double booking: concurrent bookings of overlapping time are
 * decided by the exclusion constraint, which this service reports as
 * SLOT_UNAVAILABLE. Configuration changes take the practitioner row FOR
 * UPDATE and bookings take it FOR SHARE, so a new block or new working hours
 * never race a booking.
 */

/** A walk-in may be recorded a few minutes after the hour it starts. */
const PAST_GRACE_MS = 5 * 60_000;
const OCCUPYING = OCCUPYING_STATUSES as readonly string[];

interface PractitionerRow {
  id: string;
  display_name: string;
  linked_actor_id: string | null;
  timezone: string;
  slot_minutes: number;
  default_duration_minutes: number;
  active: boolean;
}
export interface AppointmentRow {
  id: string;
  practitioner_id: string;
  booking_channel: BookingChannel;
  referral_case_id: string | null;
  patient_given_name: string;
  patient_family_name: string;
  patient_date_of_birth: string | null;
  patient_phone: string | null;
  patient_identifier: string | null;
  reason: string | null;
  status: ScheduleStatus;
  starts_at: Date;
  ends_at: Date;
  duration_minutes: number;
  timezone: string;
  rescheduled_from_id: string | null;
  rescheduled_to_id: string | null;
  cancellation_reason_code: string | null;
  checked_in_at: Date | null;
  completed_at: Date | null;
  no_show_at: Date | null;
  cancelled_at: Date | null;
  booked_by: string;
  version: number;
  created_at: Date;
}
const APPOINTMENT_COLUMNS =
  "id,practitioner_id,booking_channel,referral_case_id,patient_given_name,patient_family_name," +
  "to_char(patient_date_of_birth,'YYYY-MM-DD') AS patient_date_of_birth,patient_phone,patient_identifier,reason,status," +
  "starts_at,ends_at,duration_minutes,timezone,rescheduled_from_id,rescheduled_to_id,cancellation_reason_code," +
  "checked_in_at,completed_at,no_show_at,cancelled_at,booked_by,version,created_at";
const PRACTITIONER_COLUMNS =
  "id,display_name,linked_actor_id,timezone,slot_minutes,default_duration_minutes,active";

/** What a role may see of an appointment. */
export function appointmentView(a: AppointmentRow, role: StaffRole) {
  const details = can(role, "schedule.read_patient_details");
  // Contact details are for reception, who call the patient; a doctor sees
  // who they are seeing and why.
  const contact = details && can(role, "schedule.book");
  return {
    id: a.id,
    practitioner_id: a.practitioner_id,
    channel: a.booking_channel,
    referral_case_id: a.referral_case_id,
    status: a.status,
    starts_at: a.starts_at.toISOString(),
    ends_at: a.ends_at.toISOString(),
    duration_minutes: a.duration_minutes,
    timezone: a.timezone,
    rescheduled_from_id: a.rescheduled_from_id,
    rescheduled_to_id: a.rescheduled_to_id,
    cancellation_reason_code: a.cancellation_reason_code,
    checked_in_at: a.checked_in_at?.toISOString() ?? null,
    completed_at: a.completed_at?.toISOString() ?? null,
    no_show_at: a.no_show_at?.toISOString() ?? null,
    cancelled_at: a.cancelled_at?.toISOString() ?? null,
    version: a.version,
    patient: details
      ? {
          given_name: a.patient_given_name,
          family_name: a.patient_family_name,
          date_of_birth: a.patient_date_of_birth,
          ...(contact
            ? { phone: a.patient_phone, identifier: a.patient_identifier }
            : {}),
        }
      : null,
    reason: details ? a.reason : null,
  };
}
export type AppointmentView = ReturnType<typeof appointmentView>;

function practitionerView(p: PractitionerRow) {
  return {
    id: p.id,
    display_name: p.display_name,
    timezone: p.timezone,
    slot_minutes: p.slot_minutes,
    default_duration_minutes: p.default_duration_minutes,
    active: p.active,
  };
}

/** Database refusals that are business answers, without row detail. */
function businessError(e: unknown): unknown {
  const pg = e as { code?: string; constraint?: string };
  if (
    pg.code === "23P01" &&
    pg.constraint === "appointments_no_practitioner_overlap"
  )
    return new AppError(
      409,
      "SLOT_UNAVAILABLE",
      "that time is no longer free for this practitioner",
    );
  if (pg.code === "23P01" && pg.constraint === "working_hours_no_overlap")
    return new AppError(422, "HOURS_OVERLAP", "working sessions overlap");
  if (
    pg.code === "23505" &&
    pg.constraint === "scheduled_appointments_one_live_per_referral"
  )
    return new AppError(
      409,
      "REFERRAL_ALREADY_BOOKED",
      "this referral already has a live appointment",
    );
  return e;
}

export class ScheduleService {
  constructor(private deps: { pool: Pool; now?: () => Date }) {}
  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
  private async tx<T>(auth: AuthContext, fn: (c: DbClient) => Promise<T>) {
    try {
      return await tenantTx(
        auth.tenantId,
        fn,
        this.deps.pool,
        requestContext(auth),
      );
    } catch (e) {
      throw businessError(e);
    }
  }
  private command<T extends object>(
    auth: AuthContext,
    commandId: string,
    type: "schedule.configure" | "schedule.book" | "schedule.change",
    material: unknown,
    fn: (c: DbClient) => Promise<T>,
  ): Promise<Replayed<T>> {
    return this.tx(auth, (c) =>
      executeCommand(
        c,
        {
          tenantId: auth.tenantId,
          commandId,
          type,
          requestHash: requestHash({ type, material }),
          actor: auth.actor,
        },
        () => fn(c),
      ),
    );
  }
  private async audit(
    c: DbClient,
    auth: AuthContext,
    correlationId: string,
    action: string,
    targetType: string,
    targetId: string,
    payload: object,
  ) {
    await c.query(
      `INSERT INTO access_audit_log(tenant_id,actor_type,actor_id,actor_role,action,target_type,target_id,payload,correlation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        auth.tenantId,
        auth.actor.type,
        auth.actor.id,
        auth.role,
        action,
        targetType,
        targetId,
        payload,
        correlationId,
      ],
    );
  }

  // -------------------------------------------------------------------------
  // Practitioners and their week
  // -------------------------------------------------------------------------

  /**
   * The practitioner a caller may see. A PRACTITIONER only ever resolves to
   * their own record (and row-level security agrees); asking for another
   * answers 404, as if it did not exist.
   */
  private async practitioner(
    c: DbClient,
    auth: AuthContext,
    practitionerId: string | undefined,
    lock: "" | "FOR SHARE" | "FOR UPDATE" = "",
  ): Promise<PractitionerRow> {
    let row: PractitionerRow | undefined;
    if (auth.role === "PRACTITIONER") {
      authorize(auth.role, "schedule.read_own");
      row = (
        await c.query<PractitionerRow>(
          `SELECT ${PRACTITIONER_COLUMNS} FROM practitioners WHERE tenant_id=$1 AND linked_actor_id=$2 ${lock}`,
          [auth.tenantId, auth.actor.id],
        )
      ).rows[0];
      if (row && practitionerId && practitionerId !== row.id) row = undefined;
    } else {
      authorize(auth.role, "schedule.read");
      if (!practitionerId) throw notFound("practitioner");
      row = (
        await c.query<PractitionerRow>(
          `SELECT ${PRACTITIONER_COLUMNS} FROM practitioners WHERE tenant_id=$1 AND id=$2 ${lock}`,
          [auth.tenantId, practitionerId],
        )
      ).rows[0];
    }
    if (!row) throw notFound("practitioner");
    return row;
  }

  async listPractitioners(auth: AuthContext) {
    return this.tx(auth, async (c) => {
      if (auth.role === "PRACTITIONER")
        return [practitionerView(await this.practitioner(c, auth, undefined))];
      authorize(auth.role, "schedule.read");
      const rows = await c.query<PractitionerRow>(
        `SELECT ${PRACTITIONER_COLUMNS} FROM practitioners WHERE tenant_id=$1 ORDER BY display_name`,
        [auth.tenantId],
      );
      return rows.rows.map(practitionerView);
    });
  }

  async createPractitioner(auth: AuthContext, input: PractitionerCreate) {
    authorize(auth.role, "schedule.configure");
    return this.command(
      auth,
      input.command_id,
      "schedule.configure",
      input,
      async (c) => {
        const id = randomUUID();
        await c
          .query(
            `INSERT INTO practitioners(tenant_id,id,display_name,linked_actor_id,timezone,slot_minutes,default_duration_minutes,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              auth.tenantId,
              id,
              input.display_name,
              input.linked_actor_id ?? null,
              input.timezone,
              input.slot_minutes,
              input.default_duration_minutes,
              auth.actor.id,
            ],
          )
          .catch((e: { code?: string }) => {
            // An unknown time zone name is refused by PostgreSQL itself.
            if (e.code === "22023")
              throw new AppError(422, "TIMEZONE_INVALID", "unknown time zone");
            throw e;
          });
        await this.audit(
          c,
          auth,
          input.command_id,
          "schedule.practitioner.create",
          "practitioner",
          id,
          {
            timezone: input.timezone,
            slot_minutes: input.slot_minutes,
            linked: Boolean(input.linked_actor_id),
          },
        );
        return { practitioner_id: id };
      },
    );
  }

  /** Replace the weekly template. Existing appointments are never moved. */
  async setWorkingHours(
    auth: AuthContext,
    practitionerId: string,
    input: WorkingHoursInput,
  ) {
    authorize(auth.role, "schedule.configure");
    const parsed = workingSessions(input.sessions);
    if (!parsed.ok) throw new AppError(422, "HOURS_INVALID", parsed.problem);
    return this.command(
      auth,
      input.command_id,
      "schedule.configure",
      { practitionerId, sessions: parsed.sessions },
      async (c) => {
        await this.practitioner(c, auth, practitionerId, "FOR UPDATE");
        await c.query(
          "UPDATE practitioner_working_hours SET removed_at=now(), removed_by=$3 WHERE tenant_id=$1 AND practitioner_id=$2 AND removed_at IS NULL",
          [auth.tenantId, practitionerId, auth.actor.id],
        );
        for (const s of parsed.sessions)
          await c.query(
            `INSERT INTO practitioner_working_hours(tenant_id,practitioner_id,weekday,start_minute,end_minute,created_by)
             VALUES($1,$2,$3,$4,$5,$6)`,
            [
              auth.tenantId,
              practitionerId,
              s.weekday,
              s.start_minute,
              s.end_minute,
              auth.actor.id,
            ],
          );
        await this.audit(
          c,
          auth,
          input.command_id,
          "schedule.hours.replace",
          "practitioner",
          practitionerId,
          {
            sessions: parsed.sessions,
          },
        );
        return {
          practitioner_id: practitionerId,
          sessions: parsed.sessions.length,
        };
      },
    );
  }

  /** Block time. Refused while it would overlap a booked appointment. */
  async addBlock(
    auth: AuthContext,
    practitionerId: string,
    input: {
      command_id: string;
      starts_at: string;
      ends_at: string;
      reason_code: string;
      note?: string | undefined;
    },
  ) {
    authorize(auth.role, "schedule.configure");
    return this.command(
      auth,
      input.command_id,
      "schedule.configure",
      { practitionerId, ...input },
      async (c) => {
        await this.practitioner(c, auth, practitionerId, "FOR UPDATE");
        const clash = await c.query<{ n: number }>(
          `SELECT count(*)::int n FROM scheduled_appointments
          WHERE tenant_id=$1 AND practitioner_id=$2 AND status = ANY($5)
            AND occupied && tstzrange($3::timestamptz,$4::timestamptz,'[)')`,
          [
            auth.tenantId,
            practitionerId,
            input.starts_at,
            input.ends_at,
            OCCUPYING,
          ],
        );
        if (clash.rows[0]!.n > 0)
          throw new AppError(
            409,
            "BLOCK_OVERLAPS_APPOINTMENTS",
            `${clash.rows[0]!.n} booked appointment(s) fall in this period: move or cancel them first`,
          );
        const id = randomUUID();
        await c.query(
          `INSERT INTO practitioner_blocks(tenant_id,id,practitioner_id,reason_code,starts_at,ends_at,note,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            auth.tenantId,
            id,
            practitionerId,
            input.reason_code,
            input.starts_at,
            input.ends_at,
            input.note ?? null,
            auth.actor.id,
          ],
        );
        await this.audit(
          c,
          auth,
          input.command_id,
          "schedule.block.create",
          "practitioner_block",
          id,
          {
            practitioner_id: practitionerId,
            reason_code: input.reason_code,
            starts_at: input.starts_at,
            ends_at: input.ends_at,
          },
        );
        return { block_id: id };
      },
    );
  }

  async removeBlock(
    auth: AuthContext,
    practitionerId: string,
    blockId: string,
    commandId: string,
  ) {
    authorize(auth.role, "schedule.configure");
    return this.command(
      auth,
      commandId,
      "schedule.configure",
      { practitionerId, blockId, remove: true },
      async (c) => {
        await this.practitioner(c, auth, practitionerId, "FOR UPDATE");
        const done = await c.query(
          `UPDATE practitioner_blocks SET removed_at=now(), removed_by=$4
          WHERE tenant_id=$1 AND practitioner_id=$2 AND id=$3 AND removed_at IS NULL`,
          [auth.tenantId, practitionerId, blockId, auth.actor.id],
        );
        if (!done.rowCount) throw notFound("block");
        await this.audit(
          c,
          auth,
          commandId,
          "schedule.block.remove",
          "practitioner_block",
          blockId,
          {
            practitioner_id: practitionerId,
          },
        );
        return { block_id: blockId, removed: true };
      },
    );
  }

  // -------------------------------------------------------------------------
  // Availability and calendar
  // -------------------------------------------------------------------------

  /** Free slots, from working hours minus blocks minus occupied time. */
  private async freeSlots(
    c: DbClient,
    tenantId: string,
    p: PractitionerRow,
    from: string,
    to: string,
    duration: number,
  ) {
    const rows = await c.query<{ starts_at: Date; ends_at: Date }>(
      `WITH days AS (SELECT d::date AS day FROM generate_series($3::date, $4::date, interval '1 day') d),
            sessions AS (
              SELECT (days.day + make_interval(mins => h.start_minute)) AT TIME ZONE $6 AS ws,
                     (days.day + make_interval(mins => h.end_minute)) AT TIME ZONE $6 AS we
                FROM days JOIN practitioner_working_hours h
                  ON h.tenant_id=$1 AND h.practitioner_id=$2 AND h.removed_at IS NULL AND h.weekday = extract(isodow FROM days.day)),
            slots AS (
              SELECT s AS starts_at, s + make_interval(mins => $5) AS ends_at
                FROM sessions, generate_series(sessions.ws, sessions.we - make_interval(mins => $5),
                                               make_interval(mins => $7)) s)
       SELECT starts_at, ends_at FROM slots
        WHERE starts_at >= $8
          AND NOT EXISTS (SELECT 1 FROM practitioner_blocks b
                           WHERE b.tenant_id=$1 AND b.practitioner_id=$2 AND b.removed_at IS NULL
                             AND b.period && tstzrange(slots.starts_at, slots.ends_at, '[)'))
          AND NOT EXISTS (SELECT 1 FROM scheduled_appointments a
                           WHERE a.tenant_id=$1 AND a.practitioner_id=$2 AND a.status = ANY($9)
                             AND a.occupied && tstzrange(slots.starts_at, slots.ends_at, '[)'))
        ORDER BY starts_at`,
      [
        tenantId,
        p.id,
        from,
        to,
        duration,
        p.timezone,
        p.slot_minutes,
        this.now(),
        OCCUPYING,
      ],
    );
    return rows.rows.map((r) => ({
      starts_at: r.starts_at.toISOString(),
      ends_at: r.ends_at.toISOString(),
    }));
  }

  async availability(
    auth: AuthContext,
    practitionerId: string,
    range: { from: string; to: string; duration_minutes?: number | undefined },
  ) {
    authorize(auth.role, "schedule.read");
    return this.tx(auth, async (c) => {
      const p = await this.practitioner(c, auth, practitionerId);
      const duration = range.duration_minutes ?? p.default_duration_minutes;
      return {
        practitioner: practitionerView(p),
        duration_minutes: duration,
        slots: p.active
          ? await this.freeSlots(
              c,
              auth.tenantId,
              p,
              range.from,
              range.to,
              duration,
            )
          : [],
      };
    });
  }

  /** Day or week view: appointments, blocks and the working template. */
  async calendar(
    auth: AuthContext,
    practitionerId: string | undefined,
    range: { from: string; to: string },
  ) {
    return this.tx(auth, async (c) => {
      const p = await this.practitioner(c, auth, practitionerId);
      const bounds = await c.query<{ lo: Date; hi: Date }>(
        "SELECT ($1::date)::timestamp AT TIME ZONE $3 AS lo, ($2::date + 1)::timestamp AT TIME ZONE $3 AS hi",
        [range.from, range.to, p.timezone],
      );
      const { lo, hi } = bounds.rows[0]!;
      const appointments = await c.query<AppointmentRow>(
        `SELECT ${APPOINTMENT_COLUMNS} FROM scheduled_appointments
          WHERE tenant_id=$1 AND practitioner_id=$2 AND status <> 'RESCHEDULED'
            AND occupied && tstzrange($3,$4,'[)')
          ORDER BY starts_at`,
        [auth.tenantId, p.id, lo, hi],
      );
      const blocks = await c.query<{
        id: string;
        reason_code: string;
        starts_at: Date;
        ends_at: Date;
      }>(
        `SELECT id,reason_code,starts_at,ends_at FROM practitioner_blocks
          WHERE tenant_id=$1 AND practitioner_id=$2 AND removed_at IS NULL AND period && tstzrange($3,$4,'[)')
          ORDER BY starts_at`,
        [auth.tenantId, p.id, lo, hi],
      );
      const hours = await c.query<{
        weekday: number;
        start_minute: number;
        end_minute: number;
      }>(
        `SELECT weekday,start_minute,end_minute FROM practitioner_working_hours
          WHERE tenant_id=$1 AND practitioner_id=$2 AND removed_at IS NULL ORDER BY weekday,start_minute`,
        [auth.tenantId, p.id],
      );
      // POPIA access log: who opened whose diary, for which days. The
      // payload names no patient; the appointments are found by the range.
      await this.audit(
        c,
        auth,
        randomUUID(),
        "schedule.calendar.view",
        "practitioner",
        p.id,
        {
          from: range.from,
          to: range.to,
          appointments: appointments.rowCount ?? 0,
          patient_details: can(auth.role, "schedule.read_patient_details"),
        },
      );
      return {
        practitioner: practitionerView(p),
        from: range.from,
        to: range.to,
        window: { starts_at: lo.toISOString(), ends_at: hi.toISOString() },
        working_hours: hours.rows,
        blocks: blocks.rows.map((b) => ({
          id: b.id,
          reason_code: b.reason_code,
          starts_at: b.starts_at.toISOString(),
          ends_at: b.ends_at.toISOString(),
        })),
        appointments: appointments.rows.map((a) =>
          appointmentView(a, auth.role),
        ),
      };
    });
  }

  /**
   * One appointment and its history. An explicit read is written to the
   * access log; the read that answers a booking or change is not (the
   * appointment history already records that write).
   */
  async appointment(auth: AuthContext, appointmentId: string, audited = true) {
    return this.tx(auth, async (c) => {
      if (auth.role !== "PRACTITIONER") authorize(auth.role, "schedule.read");
      else authorize(auth.role, "schedule.read_own");
      // Row-level security hides other practitioners' rows from a
      // PRACTITIONER session: the lookup simply finds nothing.
      const row = (
        await c.query<AppointmentRow>(
          `SELECT ${APPOINTMENT_COLUMNS} FROM scheduled_appointments WHERE tenant_id=$1 AND id=$2`,
          [auth.tenantId, appointmentId],
        )
      ).rows[0];
      if (!row) throw notFound("appointment");
      const events = await c.query<{
        event_type: string;
        from_status: string | null;
        to_status: string;
        starts_at: Date;
        ends_at: Date;
        related_appointment_id: string | null;
        reason_code: string | null;
        actor_id: string;
        actor_role: string;
        occurred_at: Date;
      }>(
        `SELECT event_type,from_status,to_status,starts_at,ends_at,related_appointment_id,reason_code,actor_id,actor_role,occurred_at
           FROM scheduled_appointment_events WHERE tenant_id=$1 AND appointment_id=$2 ORDER BY occurred_at, event_type`,
        [auth.tenantId, appointmentId],
      );
      if (audited)
        await this.audit(
          c,
          auth,
          randomUUID(),
          "schedule.appointment.view",
          "scheduled_appointment",
          row.id,
          {
            practitioner_id: row.practitioner_id,
            patient_details: can(auth.role, "schedule.read_patient_details"),
          },
        );
      return {
        appointment: appointmentView(row, auth.role),
        history: events.rows.map((e) => ({
          ...e,
          starts_at: e.starts_at.toISOString(),
          ends_at: e.ends_at.toISOString(),
          occurred_at: e.occurred_at.toISOString(),
        })),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Booking
  // -------------------------------------------------------------------------

  /**
   * A time reception may book: a whole minute, not in the past, inside one
   * working session and outside every active block. Overlap with another
   * appointment is left to the exclusion constraint, so two receptionists
   * racing for the same time get exactly one booking.
   */
  private async assertBookable(
    c: DbClient,
    tenantId: string,
    p: PractitionerRow,
    startsAt: Date,
    duration: number,
  ): Promise<Date> {
    if (!p.active)
      throw new AppError(
        409,
        "PRACTITIONER_INACTIVE",
        "this practitioner takes no bookings",
      );
    if (startsAt.getUTCSeconds() !== 0 || startsAt.getUTCMilliseconds() !== 0)
      throw new AppError(
        422,
        "TIME_INVALID",
        "appointments start on a whole minute",
      );
    if (startsAt.getTime() < this.now().getTime() - PAST_GRACE_MS)
      throw new AppError(422, "TIME_IN_PAST", "that time has passed");
    const endsAt = new Date(startsAt.getTime() + duration * 60_000);
    const fit = await c.query<{ in_hours: boolean; blocked: boolean }>(
      `WITH local AS (SELECT ($3::timestamptz AT TIME ZONE $5)::date AS day)
       SELECT EXISTS (
                SELECT 1 FROM local JOIN practitioner_working_hours h
                  ON h.tenant_id=$1 AND h.practitioner_id=$2 AND h.removed_at IS NULL AND h.weekday = extract(isodow FROM local.day)
                 WHERE (local.day + make_interval(mins => h.start_minute)) AT TIME ZONE $5 <= $3::timestamptz
                   AND (local.day + make_interval(mins => h.end_minute)) AT TIME ZONE $5 >= $4::timestamptz) AS in_hours,
              EXISTS (
                SELECT 1 FROM practitioner_blocks b
                 WHERE b.tenant_id=$1 AND b.practitioner_id=$2 AND b.removed_at IS NULL
                   AND b.period && tstzrange($3::timestamptz,$4::timestamptz,'[)')) AS blocked`,
      [tenantId, p.id, startsAt, endsAt, p.timezone],
    );
    if (!fit.rows[0]!.in_hours)
      throw new AppError(
        422,
        "OUTSIDE_WORKING_HOURS",
        "that time is outside the practitioner's working hours",
      );
    if (fit.rows[0]!.blocked)
      throw new AppError(
        409,
        "TIME_BLOCKED",
        "the practitioner is unavailable at that time",
      );
    return endsAt;
  }

  private async event(
    c: DbClient,
    auth: AuthContext,
    e: {
      appointmentId: string;
      type: string;
      from: ScheduleStatus | null;
      to: ScheduleStatus;
      startsAt: Date;
      endsAt: Date;
      related?: string | null;
      reason?: string | null;
      commandId: string;
      correlationId: string;
    },
  ) {
    await c.query(
      `INSERT INTO scheduled_appointment_events(tenant_id,appointment_id,event_type,from_status,to_status,starts_at,ends_at,
                                               related_appointment_id,reason_code,actor_id,actor_role,command_id,correlation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        auth.tenantId,
        e.appointmentId,
        e.type,
        e.from,
        e.to,
        e.startsAt,
        e.endsAt,
        e.related ?? null,
        e.reason ?? null,
        auth.actor.id,
        auth.role,
        e.commandId,
        e.correlationId,
      ],
    );
  }

  /** Patient details for a referral booking come from ACCESS, not the browser. */
  private async referralPatient(
    c: DbClient,
    auth: AuthContext,
    caseId: string,
    correlationId: string,
  ) {
    const caseRow = await lockCase(c, auth.tenantId, caseId);
    if (caseRow.case_type !== "REFERRAL") throw notFound("referral");
    if (
      (await caseExecutions(c, auth.tenantId, caseId)).some(executionInFlight)
    )
      throw conflict(
        "EXECUTION_IN_FLIGHT",
        "an automated destination action is still in progress",
      );
    const readiness = await bookingReadiness(c, auth.tenantId, caseRow);
    if (!readiness.eligible)
      throw new AppError(
        409,
        "REFERRAL_NOT_BOOKABLE",
        `referral cannot be booked: ${readiness.reasons.join(", ")}`,
      );
    const r = (
      await c.query<{
        extraction: AnyExtraction | null;
        supplied_documents: ReferralFacts["supplied_documents"];
        supplied_fields: FieldsPatch;
        identity_confirmed_by: string | null;
      }>(
        "SELECT extraction,supplied_documents,supplied_fields,identity_confirmed_by FROM referrals WHERE tenant_id=$1 AND case_id=$2",
        [auth.tenantId, caseId],
      )
    ).rows[0];
    if (!r) throw notFound("referral");
    const facts: ReferralFacts = {
      extraction: r.extraction,
      supplied_documents: r.supplied_documents,
      supplied_fields: r.supplied_fields,
      identity_confirmed_by_staff: Boolean(r.identity_confirmed_by),
    };
    const given = referralField(facts, "patient.given_name");
    const family = referralField(facts, "patient.family_name");
    if (!given || !family)
      throw new AppError(
        422,
        "REFERRAL_PATIENT_INCOMPLETE",
        "the referral does not name the patient",
      );
    return {
      caseRow,
      given,
      family,
      dateOfBirth: referralField(facts, "patient.date_of_birth") ?? null,
      identifier: referralField(facts, "patient.external_id") ?? null,
      ctx: { tenantId: auth.tenantId, correlationId, actor: auth.actor },
    };
  }

  async book(auth: AuthContext, input: BookAppointment) {
    authorize(auth.role, "schedule.book");
    const correlationId = input.correlation_id ?? randomUUID();
    const result = await this.command(
      auth,
      input.command_id,
      "schedule.book",
      { ...input, correlation_id: undefined },
      async (c) => {
        const p = await this.practitioner(
          c,
          auth,
          input.practitioner_id,
          "FOR SHARE",
        );
        const duration = input.duration_minutes ?? p.default_duration_minutes;
        const startsAt = new Date(input.starts_at);
        const endsAt = await this.assertBookable(
          c,
          auth.tenantId,
          p,
          startsAt,
          duration,
        );
        const patient =
          input.channel === "REFERRAL"
            ? await this.referralPatient(
                c,
                auth,
                input.referral_case_id,
                correlationId,
              )
            : null;
        const id = randomUUID();
        await c.query(
          `INSERT INTO scheduled_appointments(tenant_id,id,practitioner_id,booking_channel,referral_case_id,patient_given_name,
                                            patient_family_name,patient_date_of_birth,patient_phone,patient_identifier,reason,status,
                                            starts_at,ends_at,duration_minutes,timezone,booked_by,booked_role)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'BOOKED',$12,$13,$14,$15,$16,$17)`,
          [
            auth.tenantId,
            id,
            p.id,
            input.channel,
            input.channel === "REFERRAL" ? input.referral_case_id : null,
            patient
              ? patient.given
              : input.channel !== "REFERRAL"
                ? input.patient.given_name
                : null,
            patient
              ? patient.family
              : input.channel !== "REFERRAL"
                ? input.patient.family_name
                : null,
            patient
              ? patient.dateOfBirth
              : input.channel !== "REFERRAL"
                ? (input.patient.date_of_birth ?? null)
                : null,
            input.channel === "REFERRAL"
              ? (input.phone ?? null)
              : (input.patient.phone ?? null),
            patient
              ? patient.identifier
              : input.channel !== "REFERRAL"
                ? (input.patient.identifier ?? null)
                : null,
            input.reason ?? null,
            startsAt,
            endsAt,
            duration,
            p.timezone,
            auth.actor.id,
            auth.role,
          ],
        );
        await this.event(c, auth, {
          appointmentId: id,
          type: "BOOKED",
          from: null,
          to: "BOOKED",
          startsAt,
          endsAt,
          reason: input.channel,
          commandId: input.command_id,
          correlationId,
        });
        if (patient) {
          // The referral's outcome, in the same transaction: either both the
          // appointment and the BOOKED referral exist, or neither does.
          const observed = await recordObservation(
            c,
            patient.ctx,
            patient.caseRow,
            {
              type: "APPOINTMENT_BOOKED",
              occurredAt: this.now(),
              sourceType: "STAFF",
              sourceReference: `schedule:${id}`,
              verificationLevel: "HUMAN_ATTESTED",
              actorId: auth.actor.id,
              authority: "STAFF",
              payload: {
                appointment_id: id,
                starts_at: startsAt.toISOString(),
                source: "native_schedule",
              },
            },
          );
          if (observed.plan.disposition !== "APPLIED")
            throw conflict(
              "REFERRAL_NOT_BOOKABLE",
              `referral cannot be booked in state ${patient.caseRow.current_state}`,
            );
        }
        log("info", "schedule_appointment_booked", {
          tenant_id: auth.tenantId,
          case_id:
            input.channel === "REFERRAL" ? input.referral_case_id : undefined,
          status: "BOOKED",
          operation: input.channel,
        });
        // The stored command result names the appointment, never the patient.
        return {
          appointment_id: id,
          status: "BOOKED" as const,
          starts_at: startsAt.toISOString(),
        };
      },
    );
    return {
      ...result,
      ...(await this.appointment(auth, result.appointment_id, false)),
    };
  }

  // -------------------------------------------------------------------------
  // Changes
  // -------------------------------------------------------------------------

  async change(
    auth: AuthContext,
    appointmentId: string,
    input: ScheduleChange,
  ) {
    const permission: Permission =
      input.action === "complete" ? "schedule.complete" : "schedule.change";
    authorize(auth.role, permission);
    const correlationId = input.correlation_id ?? randomUUID();
    const result = await this.command(
      auth,
      input.command_id,
      "schedule.change",
      { appointmentId, ...input, correlation_id: undefined },
      async (c) => {
        const a = (
          await c.query<AppointmentRow>(
            `SELECT ${APPOINTMENT_COLUMNS} FROM scheduled_appointments WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
            [auth.tenantId, appointmentId],
          )
        ).rows[0];
        if (!a) throw notFound("appointment");
        if (a.version !== input.expected_version)
          throw conflict(
            "VERSION_CONFLICT",
            `appointment version is ${a.version}, expected ${input.expected_version}`,
          );
        const to = scheduleChangeTarget(input.action);
        if (!canScheduleTransition(a.status, to))
          throw conflict(
            "INVALID_TRANSITION",
            `an appointment that is ${a.status} cannot become ${to}`,
          );
        const now = this.now();
        if (
          (input.action === "no_show" || input.action === "complete") &&
          now < a.starts_at
        )
          throw conflict("NOT_YET_DUE", "the appointment has not started yet");
        const base = {
          from: a.status,
          to,
          commandId: input.command_id,
          correlationId,
        };
        let replacementId: string | null = null;
        switch (input.action) {
          case "reschedule": {
            const p = await this.practitioner(
              c,
              auth,
              a.practitioner_id,
              "FOR SHARE",
            );
            const duration = input.duration_minutes ?? a.duration_minutes;
            const startsAt = new Date(input.starts_at);
            const endsAt = await this.assertBookable(
              c,
              auth.tenantId,
              p,
              startsAt,
              duration,
            );
            replacementId = randomUUID();
            // Close the original first, so the replacement may overlap its own
            // old time; a refused replacement rolls both back.
            await c.query(
              `UPDATE scheduled_appointments SET status='RESCHEDULED', rescheduled_to_id=$3, rescheduled_at=now(),
                      rescheduled_by=$4, version=version+1 WHERE tenant_id=$1 AND id=$2`,
              [auth.tenantId, a.id, replacementId, auth.actor.id],
            );
            await c.query(
              `INSERT INTO scheduled_appointments(tenant_id,id,practitioner_id,booking_channel,referral_case_id,patient_given_name,
                                                  patient_family_name,patient_date_of_birth,patient_phone,patient_identifier,reason,
                                                  status,starts_at,ends_at,duration_minutes,timezone,booked_by,booked_role,rescheduled_from_id)
               SELECT tenant_id,$3,practitioner_id,booking_channel,referral_case_id,patient_given_name,patient_family_name,
                      patient_date_of_birth,patient_phone,patient_identifier,reason,'BOOKED',$4,$5,$6,timezone,$7,$8,id
                 FROM scheduled_appointments WHERE tenant_id=$1 AND id=$2`,
              [
                auth.tenantId,
                a.id,
                replacementId,
                startsAt,
                endsAt,
                duration,
                auth.actor.id,
                auth.role,
              ],
            );
            await this.event(c, auth, {
              ...base,
              appointmentId: a.id,
              type: "RESCHEDULED",
              startsAt: a.starts_at,
              endsAt: a.ends_at,
              related: replacementId,
            });
            await this.event(c, auth, {
              ...base,
              from: null,
              to: "BOOKED",
              appointmentId: replacementId,
              type: "BOOKED",
              startsAt,
              endsAt,
              related: a.id,
              reason: "RESCHEDULE",
            });
            if (a.referral_case_id) {
              const caseRow = await lockCase(
                c,
                auth.tenantId,
                a.referral_case_id,
              );
              await evidence(
                c,
                { tenantId: auth.tenantId, correlationId, actor: auth.actor },
                caseRow,
                { type: "case", id: caseRow.id },
                {
                  eventType: "schedule_appointment_rescheduled",
                  payload: {
                    from_appointment_id: a.id,
                    to_appointment_id: replacementId,
                    starts_at: startsAt.toISOString(),
                  },
                },
              );
            }
            break;
          }
          case "cancel":
            await c.query(
              `UPDATE scheduled_appointments SET status='CANCELLED', cancelled_at=now(), cancelled_by=$3,
                      cancellation_reason_code=$4, cancellation_note=$5, version=version+1 WHERE tenant_id=$1 AND id=$2`,
              [
                auth.tenantId,
                a.id,
                auth.actor.id,
                input.reason_code,
                input.note ?? null,
              ],
            );
            await this.event(c, auth, {
              ...base,
              appointmentId: a.id,
              type: "CANCELLED",
              startsAt: a.starts_at,
              endsAt: a.ends_at,
              reason: input.reason_code,
            });
            if (a.referral_case_id) {
              // A BOOKED referral is terminal: the cancellation is recorded
              // and raised for manager review, exactly as an external one is.
              const caseRow = await lockCase(
                c,
                auth.tenantId,
                a.referral_case_id,
              );
              await recordObservation(
                c,
                { tenantId: auth.tenantId, correlationId, actor: auth.actor },
                caseRow,
                {
                  type: "APPOINTMENT_CANCELLED",
                  occurredAt: now,
                  sourceType: "STAFF",
                  sourceReference: `schedule-cancel:${a.id}`,
                  verificationLevel: "HUMAN_ATTESTED",
                  actorId: auth.actor.id,
                  authority: "STAFF",
                  payload: {
                    appointment_id: a.id,
                    reason_code: input.reason_code,
                    source: "native_schedule",
                  },
                },
              );
            }
            break;
          case "check_in":
            await c.query(
              `UPDATE scheduled_appointments SET status='CHECKED_IN', checked_in_at=now(), checked_in_by=$3,
                      no_show_at=NULL, no_show_by=NULL, version=version+1 WHERE tenant_id=$1 AND id=$2`,
              [auth.tenantId, a.id, auth.actor.id],
            );
            await this.event(c, auth, {
              ...base,
              appointmentId: a.id,
              type: "CHECKED_IN",
              startsAt: a.starts_at,
              endsAt: a.ends_at,
            });
            break;
          case "complete":
            await c.query(
              `UPDATE scheduled_appointments SET status='COMPLETED', completed_at=now(), completed_by=$3, version=version+1
                WHERE tenant_id=$1 AND id=$2`,
              [auth.tenantId, a.id, auth.actor.id],
            );
            await this.event(c, auth, {
              ...base,
              appointmentId: a.id,
              type: "COMPLETED",
              startsAt: a.starts_at,
              endsAt: a.ends_at,
            });
            break;
          case "no_show":
            await c.query(
              `UPDATE scheduled_appointments SET status='NO_SHOW', no_show_at=now(), no_show_by=$3, version=version+1
                WHERE tenant_id=$1 AND id=$2`,
              [auth.tenantId, a.id, auth.actor.id],
            );
            await this.event(c, auth, {
              ...base,
              appointmentId: a.id,
              type: "NO_SHOW",
              startsAt: a.starts_at,
              endsAt: a.ends_at,
            });
            break;
        }
        log("info", "schedule_appointment_changed", {
          tenant_id: auth.tenantId,
          status: to,
          operation: input.action,
        });
        return {
          appointment_id: replacementId ?? a.id,
          previous_appointment_id: replacementId ? a.id : null,
          status: replacementId ? ("BOOKED" as const) : to,
        };
      },
    );
    return {
      ...result,
      ...(await this.appointment(auth, result.appointment_id, false)),
    };
  }
}
