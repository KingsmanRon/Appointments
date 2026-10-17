import { z } from "zod";

// ---------------------------------------------------------------------------
// Native scheduling: ACCESS's own appointment book (migration 0007).
// Self-contained (no import from index.ts) so the barrel export has no cycle.
// ---------------------------------------------------------------------------

const id = z.string().uuid();
const commandId = id;
const instant = z.iso.datetime({ offset: true });
const localDate = z.iso.date();
const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (v) =>
      ![...v].some(
        (ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f,
      ),
    "no control characters",
  );

export const BOOKING_CHANNELS = ["TELEPHONE", "WALK_IN", "REFERRAL"] as const;
export type BookingChannel = (typeof BOOKING_CHANNELS)[number];

export const SCHEDULE_STATUSES = [
  "BOOKED",
  "CHECKED_IN",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
  "RESCHEDULED",
] as const;
export type ScheduleStatus = (typeof SCHEDULE_STATUSES)[number];
/** Statuses that occupy the practitioner's time (the overlap constraint). */
export const OCCUPYING_STATUSES: readonly ScheduleStatus[] = [
  "BOOKED",
  "CHECKED_IN",
  "COMPLETED",
];

export const BLOCK_REASONS = [
  "LEAVE",
  "ADMIN",
  "MEETING",
  "BREAK",
  "PERSONAL",
  "PUBLIC_HOLIDAY",
  "OTHER",
] as const;
export const SCHEDULE_CANCELLATION_REASONS = [
  "PATIENT_REQUEST",
  "PRACTICE_REQUEST",
  "PRACTITIONER_UNAVAILABLE",
  "DUPLICATE_BOOKING",
  "OTHER",
] as const;

/** "08:30"; "24:00" ends a session at midnight. */
const clock = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/, "use HH:MM");

export const practitionerCreateSchema = z
  .object({
    command_id: commandId,
    display_name: z.string().trim().min(1).max(120),
    timezone: z.string().min(1).max(64),
    slot_minutes: z
      .union([
        z.literal(5),
        z.literal(10),
        z.literal(15),
        z.literal(20),
        z.literal(30),
        z.literal(60),
      ])
      .default(15),
    default_duration_minutes: z.number().int().min(5).max(240).default(15),
    /** user:<JWT subject> or synthetic:<user>: their own calendar. */
    linked_actor_id: z
      .string()
      .regex(/^(user|synthetic):[A-Za-z0-9_.:-]{1,190}$/)
      .optional(),
  })
  .strict();
export type PractitionerCreate = z.infer<typeof practitionerCreateSchema>;

export const workingHoursSchema = z
  .object({
    command_id: commandId,
    sessions: z
      .array(
        z
          .object({
            weekday: z.number().int().min(1).max(7),
            start: clock,
            end: clock,
          })
          .strict(),
      )
      .max(28),
  })
  .strict();
export type WorkingHoursInput = z.infer<typeof workingHoursSchema>;

export const blockCreateSchema = z
  .object({
    command_id: commandId,
    starts_at: instant,
    ends_at: instant,
    reason_code: z.enum(BLOCK_REASONS),
    note: z.string().trim().max(200).optional(),
  })
  .strict()
  .refine((b) => new Date(b.ends_at) > new Date(b.starts_at), {
    message: "a block must end after it starts",
    path: ["ends_at"],
  });
export const blockRemoveSchema = z.object({ command_id: commandId }).strict();

/** Days are calendar dates in the practitioner's own time zone. */
export const scheduleRangeSchema = z
  .object({
    from: localDate,
    to: localDate,
    duration_minutes: z.coerce.number().int().min(5).max(240).optional(),
  })
  .refine((r) => r.to >= r.from, { message: "to must not precede from" })
  .refine(
    (r) =>
      (new Date(`${r.to}T00:00:00Z`).getTime() -
        new Date(`${r.from}T00:00:00Z`).getTime()) /
        86_400_000 <=
      41,
    { message: "a range covers at most 6 weeks" },
  );

const patientSchema = z
  .object({
    given_name: name,
    family_name: name,
    date_of_birth: localDate.optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,24}$/, "a phone number")
      .optional(),
    identifier: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9 /-]{0,99}$/)
      .optional(),
  })
  .strict();
const bookingBase = {
  command_id: commandId,
  correlation_id: id.optional(),
  practitioner_id: id,
  starts_at: instant,
  duration_minutes: z.number().int().min(5).max(240).optional(),
  reason: z.string().trim().max(500).optional(),
};
/**
 * Reception books an appointment. A telephone or walk-in booking carries the
 * patient's details and needs no referral; a referral booking takes the
 * patient from the ACCESS referral, never from the browser.
 */
export const bookAppointmentSchema = z.discriminatedUnion("channel", [
  z
    .object({
      channel: z.literal("TELEPHONE"),
      ...bookingBase,
      // A telephone booking keeps a number to call back.
      patient: patientSchema.extend({
        phone: patientSchema.shape.phone.unwrap(),
      }),
    })
    .strict(),
  z
    .object({
      channel: z.literal("WALK_IN"),
      ...bookingBase,
      patient: patientSchema,
    })
    .strict(),
  z
    .object({
      channel: z.literal("REFERRAL"),
      ...bookingBase,
      referral_case_id: id,
      /** Optional number to reach the patient; the referral has none. */
      phone: patientSchema.shape.phone,
    })
    .strict(),
]);
export type BookAppointment = z.infer<typeof bookAppointmentSchema>;

const changeBase = {
  command_id: commandId,
  correlation_id: id.optional(),
  expected_version: z.number().int().nonnegative(),
};
export const scheduleChangeSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("reschedule"),
      ...changeBase,
      starts_at: instant,
      duration_minutes: z.number().int().min(5).max(240).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      ...changeBase,
      reason_code: z.enum(SCHEDULE_CANCELLATION_REASONS),
      note: z.string().trim().max(500).optional(),
    })
    .strict(),
  z.object({ action: z.literal("check_in"), ...changeBase }).strict(),
  z.object({ action: z.literal("complete"), ...changeBase }).strict(),
  z.object({ action: z.literal("no_show"), ...changeBase }).strict(),
]);
export type ScheduleChange = z.infer<typeof scheduleChangeSchema>;
export type ScheduleChangeName = ScheduleChange["action"];
export const SCHEDULE_CHANGES = scheduleChangeSchema.options.map(
  (o) => o.shape.action.value,
);
