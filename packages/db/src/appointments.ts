import { randomUUID } from "node:crypto";
import type {
  AppointmentCaseType,
  AppointmentSearch,
  AppointmentSlot,
  AppointmentStatus,
  AppointmentWorkflowStatus,
  BookingContext,
  CancellationReason,
  ConfirmationStatus,
  HoldStatus,
} from "@access/contracts";
import { workflowStep } from "@access/domain";
import { conflict, notFound, type DbClient } from "./runtime.js";

/**
 * Data access for appointment operations. Every write happens inside the
 * caller's transaction, under the lock of the owning case; every update of a
 * request or an appointment increments its version exactly once (enforced by
 * the 0006 triggers).
 */

export interface AvailabilitySnapshot {
  execution_id: string;
  observed_at: string;
  slots: AppointmentSlot[];
}
export interface AppointmentRequestRow {
  tenant_id: string;
  case_id: string;
  case_type: AppointmentCaseType;
  origin_referral_case_id: string | null;
  original_appointment_id: string | null;
  appointment_id: string | null;
  booking_context: BookingContext;
  search: AppointmentSearch | null;
  timezone: string;
  workflow_status: AppointmentWorkflowStatus;
  availability: AvailabilitySnapshot | null;
  availability_observed_at: Date | null;
  selected_slot: AppointmentSlot | null;
  selected_slot_reference: string | null;
  selected_at: Date | null;
  current_hold_id: string | null;
  pending_execution_id: string | null;
  cancellation_reason: CancellationReason | null;
  last_failure_code: string | null;
  last_failure_at: Date | null;
  recheck_requested_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const requestColumns =
  "tenant_id,case_id,case_type,origin_referral_case_id,original_appointment_id,appointment_id,booking_context,search,timezone," +
  "workflow_status,availability,availability_observed_at,selected_slot,selected_slot_reference,selected_at,current_hold_id," +
  "pending_execution_id,cancellation_reason,last_failure_code,last_failure_at,recheck_requested_at,version,created_at,updated_at";

export async function findRequest(
  c: DbClient,
  tenantId: string,
  caseId: string,
  lock = false,
): Promise<AppointmentRequestRow | undefined> {
  const row = await c.query<AppointmentRequestRow>(
    `SELECT ${requestColumns} FROM appointment_requests WHERE tenant_id=$1 AND case_id=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, caseId],
  );
  return row.rows[0];
}
export async function lockRequest(
  c: DbClient,
  tenantId: string,
  caseId: string,
): Promise<AppointmentRequestRow> {
  const row = await findRequest(c, tenantId, caseId, true);
  if (!row) throw notFound("appointment request");
  return row;
}

export async function insertRequest(
  c: DbClient,
  input: {
    tenantId: string;
    caseId: string;
    caseType: AppointmentCaseType;
    originReferralCaseId: string | null;
    originalAppointmentId: string | null;
    bookingContext: BookingContext;
    search: AppointmentSearch | null;
    timezone: string;
    workflowStatus: AppointmentWorkflowStatus;
    pendingExecutionId: string | null;
    cancellationReason?: CancellationReason | null;
  },
): Promise<AppointmentRequestRow> {
  try {
    const row = await c.query<AppointmentRequestRow>(
      `INSERT INTO appointment_requests(tenant_id,case_id,case_type,origin_referral_case_id,original_appointment_id,booking_context,
                                        search,timezone,workflow_status,pending_execution_id,cancellation_reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING ${requestColumns}`,
      [
        input.tenantId,
        input.caseId,
        input.caseType,
        input.originReferralCaseId,
        input.originalAppointmentId,
        input.bookingContext,
        input.search,
        input.timezone,
        input.workflowStatus,
        input.pendingExecutionId,
        input.cancellationReason ?? null,
      ],
    );
    return row.rows[0]!;
  } catch (error) {
    // The partial unique indexes: one active booking per referral, one active
    // change per appointment.
    if ((error as { code?: string }).code === "23505")
      throw conflict(
        input.caseType === "APPOINTMENT_REQUEST"
          ? "BOOKING_ALREADY_ACTIVE"
          : "APPOINTMENT_CHANGE_ACTIVE",
        input.caseType === "APPOINTMENT_REQUEST"
          ? "a booking is already in progress for this referral"
          : "a reschedule or cancellation is already in progress for this appointment",
      );
    throw error;
  }
}

export type RequestPatch = Partial<
  Pick<
    AppointmentRequestRow,
    | "workflow_status"
    | "appointment_id"
    | "search"
    | "availability"
    | "availability_observed_at"
    | "selected_slot"
    | "selected_slot_reference"
    | "selected_at"
    | "current_hold_id"
    | "pending_execution_id"
    | "last_failure_code"
    | "last_failure_at"
    | "recheck_requested_at"
  >
>;
const patchable: (keyof RequestPatch)[] = [
  "workflow_status",
  "appointment_id",
  "search",
  "availability",
  "availability_observed_at",
  "selected_slot",
  "selected_slot_reference",
  "selected_at",
  "current_hold_id",
  "pending_execution_id",
  "last_failure_code",
  "last_failure_at",
  "recheck_requested_at",
];
/** Update a locked request; a workflow change must be a permitted step. */
export async function updateRequest(
  c: DbClient,
  row: AppointmentRequestRow,
  patch: RequestPatch,
): Promise<AppointmentRequestRow> {
  if (
    patch.workflow_status !== undefined &&
    patch.workflow_status !== row.workflow_status
  )
    workflowStep(row.case_type, row.workflow_status, patch.workflow_status);
  const keys = patchable.filter((k) => patch[k] !== undefined);
  const updated = await c.query<AppointmentRequestRow>(
    `UPDATE appointment_requests SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")}${keys.length ? "," : ""}
            version=version+1,updated_at=now()
      WHERE tenant_id=$1 AND case_id=$2 RETURNING ${requestColumns}`,
    [row.tenant_id, row.case_id, ...keys.map((k) => patch[k])],
  );
  return updated.rows[0]!;
}

/** The active booking request of a referral, if any. */
export async function activeBookingForReferral(
  c: DbClient,
  tenantId: string,
  referralCaseId: string,
): Promise<AppointmentRequestRow | undefined> {
  const row = await c.query<AppointmentRequestRow>(
    `SELECT ${requestColumns} FROM appointment_requests
      WHERE tenant_id=$1 AND origin_referral_case_id=$2 AND case_type='APPOINTMENT_REQUEST'
        AND workflow_status NOT IN ('BOOKED','WITHDRAWN')`,
    [tenantId, referralCaseId],
  );
  return row.rows[0];
}
/** Every appointment operations request that serves a referral. */
export async function requestsForReferral(
  c: DbClient,
  tenantId: string,
  referralCaseId: string,
): Promise<AppointmentRequestRow[]> {
  const rows = await c.query<AppointmentRequestRow>(
    `SELECT ${requestColumns} FROM appointment_requests
      WHERE tenant_id=$1 AND (origin_referral_case_id=$2 OR original_appointment_id IN
            (SELECT id FROM appointments WHERE tenant_id=$1 AND origin_referral_case_id=$2))
      ORDER BY created_at`,
    [tenantId, referralCaseId],
  );
  return rows.rows;
}

export interface AppointmentRow {
  id: string;
  tenant_id: string;
  source_case_id: string;
  origin_referral_case_id: string | null;
  destination: string;
  external_reference: string;
  slot_reference: string;
  provider_reference: string | null;
  location_reference: string | null;
  service_code: string | null;
  patient_reference: string | null;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  status: AppointmentStatus;
  committed_at: Date;
  commit_source: "CONNECTOR" | "RECONCILIATION";
  create_execution_id: string;
  cancelled_at: Date | null;
  cancellation_source: "CONNECTOR" | "RECONCILIATION" | "STAFF" | null;
  replaces_appointment_id: string | null;
  superseded_by_id: string | null;
  confirmation_status: ConfirmationStatus;
  confirmed_at: Date | null;
  confirmation_source: "STAFF" | null;
  confirmation_method: string | null;
  confirmed_by: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}
const appointmentColumns =
  "id,tenant_id,source_case_id,origin_referral_case_id,destination,external_reference,slot_reference,provider_reference," +
  "location_reference,service_code,patient_reference,starts_at,ends_at,timezone,status,committed_at,commit_source," +
  "create_execution_id,cancelled_at,cancellation_source,replaces_appointment_id,superseded_by_id,confirmation_status," +
  "confirmed_at,confirmation_source,confirmation_method,confirmed_by,version,created_at,updated_at";

export async function findAppointment(
  c: DbClient,
  tenantId: string,
  id: string,
  lock = false,
): Promise<AppointmentRow | undefined> {
  const row = await c.query<AppointmentRow>(
    `SELECT ${appointmentColumns} FROM appointments WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, id],
  );
  return row.rows[0];
}
export async function lockAppointment(
  c: DbClient,
  tenantId: string,
  id: string,
): Promise<AppointmentRow> {
  const row = await findAppointment(c, tenantId, id, true);
  if (!row) throw notFound("appointment");
  return row;
}
export async function appointmentByExecution(
  c: DbClient,
  tenantId: string,
  executionId: string,
): Promise<AppointmentRow | undefined> {
  const row = await c.query<AppointmentRow>(
    `SELECT ${appointmentColumns} FROM appointments WHERE tenant_id=$1 AND create_execution_id=$2`,
    [tenantId, executionId],
  );
  return row.rows[0];
}
export async function appointmentsForReferral(
  c: DbClient,
  tenantId: string,
  referralCaseId: string,
): Promise<AppointmentRow[]> {
  const rows = await c.query<AppointmentRow>(
    `SELECT ${appointmentColumns} FROM appointments WHERE tenant_id=$1 AND origin_referral_case_id=$2 ORDER BY committed_at,id`,
    [tenantId, referralCaseId],
  );
  return rows.rows;
}

/**
 * Record a committed foreign appointment. Idempotent per committing
 * execution: settling the same result twice returns the same row.
 */
export async function insertAppointment(
  c: DbClient,
  input: {
    tenantId: string;
    sourceCaseId: string;
    originReferralCaseId: string | null;
    destination: string;
    externalReference: string;
    slotReference: string;
    providerReference: string | null;
    locationReference: string | null;
    serviceCode: string | null;
    patientReference: string | null;
    startsAt: string;
    endsAt: string;
    timezone: string;
    commitSource: "CONNECTOR" | "RECONCILIATION";
    createExecutionId: string;
    replacesAppointmentId: string | null;
  },
): Promise<AppointmentRow> {
  const inserted = await c.query<AppointmentRow>(
    `INSERT INTO appointments(id,tenant_id,source_case_id,origin_referral_case_id,destination,external_reference,slot_reference,
                              provider_reference,location_reference,service_code,patient_reference,starts_at,ends_at,timezone,
                              status,committed_at,commit_source,create_execution_id,replaces_appointment_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'BOOKED',now(),$15,$16,$17)
     ON CONFLICT (tenant_id,create_execution_id) DO NOTHING RETURNING ${appointmentColumns}`,
    [
      randomUUID(),
      input.tenantId,
      input.sourceCaseId,
      input.originReferralCaseId,
      input.destination,
      input.externalReference,
      input.slotReference,
      input.providerReference,
      input.locationReference,
      input.serviceCode,
      input.patientReference,
      input.startsAt,
      input.endsAt,
      input.timezone,
      input.commitSource,
      input.createExecutionId,
      input.replacesAppointmentId,
    ],
  );
  return (
    inserted.rows[0] ??
    (await appointmentByExecution(c, input.tenantId, input.createExecutionId))!
  );
}

export type AppointmentPatch = Partial<
  Pick<
    AppointmentRow,
    | "status"
    | "cancelled_at"
    | "cancellation_source"
    | "superseded_by_id"
    | "confirmation_status"
    | "confirmed_at"
    | "confirmation_source"
    | "confirmation_method"
    | "confirmed_by"
  >
>;
export async function updateAppointment(
  c: DbClient,
  row: AppointmentRow,
  patch: AppointmentPatch,
): Promise<AppointmentRow> {
  const keys = (Object.keys(patch) as (keyof AppointmentPatch)[]).filter(
    (k) => patch[k] !== undefined,
  );
  const updated = await c.query<AppointmentRow>(
    `UPDATE appointments SET ${keys.map((k, i) => `${k}=$${i + 3}`).join(",")}${keys.length ? "," : ""}
            version=version+1,updated_at=now()
      WHERE tenant_id=$1 AND id=$2 RETURNING ${appointmentColumns}`,
    [row.tenant_id, row.id, ...keys.map((k) => patch[k])],
  );
  return updated.rows[0]!;
}

export interface HoldRow {
  id: string;
  tenant_id: string;
  case_id: string;
  slot_reference: string;
  hold_reference: string;
  execution_id: string;
  status: HoldStatus;
  created_at: Date;
  expires_at: Date;
  closed_at: Date | null;
}
const holdColumns =
  "id,tenant_id,case_id,slot_reference,hold_reference,execution_id,status,created_at,expires_at,closed_at";

export async function findHold(
  c: DbClient,
  tenantId: string,
  id: string,
): Promise<HoldRow | undefined> {
  const row = await c.query<HoldRow>(
    `SELECT ${holdColumns} FROM appointment_slot_holds WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
    [tenantId, id],
  );
  return row.rows[0];
}
export async function holdsForRequest(
  c: DbClient,
  tenantId: string,
  caseId: string,
): Promise<HoldRow[]> {
  const rows = await c.query<HoldRow>(
    `SELECT ${holdColumns} FROM appointment_slot_holds WHERE tenant_id=$1 AND case_id=$2 ORDER BY created_at,id`,
    [tenantId, caseId],
  );
  return rows.rows;
}
/** A hold that is already past its expiry is recorded as EXPIRED. */
export async function insertHold(
  c: DbClient,
  input: {
    tenantId: string;
    caseId: string;
    slotReference: string;
    holdReference: string;
    executionId: string;
    expiresAt: string;
  },
): Promise<HoldRow> {
  const inserted = await c.query<HoldRow>(
    `INSERT INTO appointment_slot_holds(id,tenant_id,case_id,slot_reference,hold_reference,execution_id,status,expires_at,closed_at)
     VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::timestamptz > now() THEN 'ACTIVE' ELSE 'EXPIRED' END,$7,
            CASE WHEN $7::timestamptz > now() THEN NULL ELSE now() END)
     ON CONFLICT (tenant_id,execution_id) DO NOTHING RETURNING ${holdColumns}`,
    [
      randomUUID(),
      input.tenantId,
      input.caseId,
      input.slotReference,
      input.holdReference,
      input.executionId,
      input.expiresAt,
    ],
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const existing = await c.query<HoldRow>(
    `SELECT ${holdColumns} FROM appointment_slot_holds WHERE tenant_id=$1 AND execution_id=$2`,
    [input.tenantId, input.executionId],
  );
  return existing.rows[0]!;
}
/** Close an ACTIVE hold once; a closed hold is left as it is. */
export async function closeHold(
  c: DbClient,
  tenantId: string,
  id: string,
  status: Exclude<HoldStatus, "ACTIVE">,
): Promise<boolean> {
  const updated = await c.query(
    "UPDATE appointment_slot_holds SET status=$3,closed_at=now() WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE'",
    [tenantId, id, status],
  );
  return (updated.rowCount ?? 0) > 0;
}

/** Release BLOCKED steps of a case's plan for dispatch. */
export async function releaseStep(
  c: DbClient,
  tenantId: string,
  executionId: string,
): Promise<boolean> {
  const updated = await c.query(
    `UPDATE outbox o SET status='PENDING',available_at=now()
      WHERE o.tenant_id=$1 AND o.execution_id=$2 AND o.status='BLOCKED'
        AND EXISTS (SELECT 1 FROM executions e WHERE e.tenant_id=o.tenant_id AND e.id=o.execution_id AND e.superseded_at IS NULL)`,
    [tenantId, executionId],
  );
  return (updated.rowCount ?? 0) > 0;
}
/** Close BLOCKED steps that will never run; their executions never started. */
export async function cancelBlockedSteps(
  c: DbClient,
  tenantId: string,
  caseId: string,
  by: string,
): Promise<string[]> {
  const closed = await c.query<{ execution_id: string }>(
    `UPDATE outbox SET status='DONE',last_error='NOT_ATTEMPTED' WHERE tenant_id=$1 AND case_id=$2 AND status='BLOCKED'
     RETURNING execution_id`,
    [tenantId, caseId],
  );
  const ids = closed.rows.map((r) => r.execution_id);
  if (ids.length)
    await c.query(
      `UPDATE executions SET status='PERMANENT',last_error='NOT_ATTEMPTED',superseded_at=now(),superseded_by=$3,
              superseded_reason='plan_cancelled',updated_at=now()
        WHERE tenant_id=$1 AND id = ANY($2) AND status='PENDING'`,
      [tenantId, ids, by],
    );
  return ids;
}
/** The planned (BLOCKED) step of a case for one operation. */
export async function blockedStep(
  c: DbClient,
  tenantId: string,
  caseId: string,
  operation: string,
): Promise<string | undefined> {
  const row = await c.query<{ execution_id: string }>(
    "SELECT execution_id FROM outbox WHERE tenant_id=$1 AND case_id=$2 AND operation=$3 AND status='BLOCKED' ORDER BY id LIMIT 1",
    [tenantId, caseId, operation],
  );
  return row.rows[0]?.execution_id;
}
