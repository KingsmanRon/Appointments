import type pg from "pg";
import { tenantTx } from "./runtime.js";

/**
 * Retention purge for one organisation's appointment book (operator only,
 * migration credential). Appointments and their history are otherwise never
 * deleted: the guard triggers refuse it for every role. This lifts them for
 * the length of one transaction, removes only what is finished, and records
 * what it did in the audit log (counts, never patient details).
 *
 * A reschedule chain goes as a whole or not at all: every appointment in it
 * must be finished (cancelled, completed, did not attend or moved) and have
 * ended before the cutoff. Anything still booked or checked in stays, however
 * old, until reception resolves it.
 */
export interface SchedulePurgeOptions {
  tenantId: string;
  /** Delete what ended before this instant. */
  before: Date;
  /** Who ran it, for the audit log (an operator name or ticket). */
  operator: string;
  /** false: count, then roll back. */
  confirm: boolean;
  now?: Date;
}
export interface SchedulePurgeResult {
  tenant_id: string;
  before: string;
  appointments: number;
  events: number;
  blocks: number;
  committed: boolean;
}
const MIN_AGE_MS = 24 * 60 * 60 * 1000;
class DryRun extends Error {
  constructor(readonly result: SchedulePurgeResult) {
    super("dry run");
  }
}

export async function purgeSchedule(
  owner: pg.Pool,
  options: SchedulePurgeOptions,
): Promise<SchedulePurgeResult> {
  const now = options.now ?? new Date();
  if (Number.isNaN(options.before.getTime()))
    throw new Error("the cutoff must be a valid instant");
  if (options.before.getTime() > now.getTime() - MIN_AGE_MS)
    throw new Error("the cutoff must be at least a day in the past");
  if (!/^[A-Za-z0-9 ._@:-]{1,80}$/.test(options.operator))
    throw new Error("operator must name who runs the purge");
  try {
    return await tenantTx(
      options.tenantId,
      async (c) => {
        await c.query("SET LOCAL lock_timeout = '5s'");
        const targets = await c.query<{ id: string }>(
          `WITH RECURSIVE chain(root, id) AS (
             SELECT id, id FROM scheduled_appointments
              WHERE tenant_id = $1 AND rescheduled_from_id IS NULL
             UNION ALL
             SELECT chain.root, a.id FROM chain
               JOIN scheduled_appointments a
                 ON a.tenant_id = $1 AND a.rescheduled_from_id = chain.id
           ), finished AS (
             SELECT chain.root FROM chain
               JOIN scheduled_appointments a ON a.tenant_id = $1 AND a.id = chain.id
              GROUP BY chain.root
             HAVING bool_and(a.status NOT IN ('BOOKED','CHECKED_IN') AND a.ends_at < $2)
           )
           SELECT chain.id FROM chain JOIN finished USING (root)`,
          [options.tenantId, options.before],
        );
        const ids = targets.rows.map((r) => r.id);
        // Lifted inside this transaction only: other sessions never see the
        // triggers off, and writers wait on the lock until they are back.
        await c.query(
          "ALTER TABLE scheduled_appointment_events DISABLE TRIGGER scheduled_appointment_events_append_only",
        );
        await c.query(
          "ALTER TABLE scheduled_appointments DISABLE TRIGGER scheduled_appointments_guard",
        );
        const events = await c.query(
          "DELETE FROM scheduled_appointment_events WHERE tenant_id = $1 AND appointment_id = ANY($2::uuid[])",
          [options.tenantId, ids],
        );
        const appointments = await c.query(
          "DELETE FROM scheduled_appointments WHERE tenant_id = $1 AND id = ANY($2::uuid[])",
          [options.tenantId, ids],
        );
        const blocks = await c.query(
          "DELETE FROM practitioner_blocks WHERE tenant_id = $1 AND ends_at < $2",
          [options.tenantId, options.before],
        );
        // Check the deferred chain and referral keys now: the triggers cannot
        // be re-enabled while their checks are still queued.
        await c.query("SET CONSTRAINTS ALL IMMEDIATE");
        await c.query(
          "ALTER TABLE scheduled_appointments ENABLE TRIGGER scheduled_appointments_guard",
        );
        await c.query(
          "ALTER TABLE scheduled_appointment_events ENABLE TRIGGER scheduled_appointment_events_append_only",
        );
        const result: SchedulePurgeResult = {
          tenant_id: options.tenantId,
          before: options.before.toISOString(),
          appointments: appointments.rowCount ?? 0,
          events: events.rowCount ?? 0,
          blocks: blocks.rowCount ?? 0,
          committed: options.confirm,
        };
        if (!options.confirm) throw new DryRun(result);
        await c.query(
          `INSERT INTO access_audit_log(tenant_id,actor_type,actor_id,actor_role,action,target_type,target_id,payload,correlation_id)
           VALUES($1::uuid,'SYSTEM',$2,'OPERATOR','schedule.retention.purge','organisation',$1::text,$3,gen_random_uuid())`,
          [
            options.tenantId,
            `operator:${options.operator}`,
            {
              before: result.before,
              appointments: result.appointments,
              events: result.events,
              blocks: result.blocks,
            },
          ],
        );
        return result;
      },
      owner,
      // Owner context, as the seed and the tenant bootstrap use.
      { actorRole: "ADMIN" },
    );
  } catch (e) {
    if (e instanceof DryRun) return e.result;
    throw e;
  }
}
