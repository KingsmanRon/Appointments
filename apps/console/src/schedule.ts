// Native scheduling: types and time helpers shared by the reception screen
// and the calendar. Every time is shown in the practitioner's own time zone.

export type Channel = "TELEPHONE" | "WALK_IN" | "REFERRAL";
export type ScheduleStatus =
  | "BOOKED"
  | "CHECKED_IN"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW"
  | "RESCHEDULED";

export interface Practitioner {
  id: string;
  display_name: string;
  timezone: string;
  slot_minutes: number;
  default_duration_minutes: number;
  active: boolean;
}
export interface ScheduledAppointment {
  id: string;
  practitioner_id: string;
  channel: Channel;
  referral_case_id: string | null;
  status: ScheduleStatus;
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  timezone: string;
  rescheduled_from_id: string | null;
  rescheduled_to_id: string | null;
  cancellation_reason_code: string | null;
  version: number;
  patient: {
    given_name: string;
    family_name: string;
    date_of_birth: string | null;
    phone?: string | null;
    identifier?: string | null;
  } | null;
  reason: string | null;
}
export interface CalendarView {
  practitioner: Practitioner;
  from: string;
  to: string;
  window: { starts_at: string; ends_at: string };
  working_hours: {
    weekday: number;
    start_minute: number;
    end_minute: number;
  }[];
  blocks: {
    id: string;
    reason_code: string;
    starts_at: string;
    ends_at: string;
  }[];
  appointments: ScheduledAppointment[];
}
export interface AppointmentDetail {
  appointment: ScheduledAppointment;
  history: {
    event_type: string;
    from_status: string | null;
    to_status: string;
    starts_at: string;
    occurred_at: string;
    actor_role: string;
    reason_code: string | null;
  }[];
}

export const CHANNEL_LABELS: Record<Channel, string> = {
  TELEPHONE: "Telephone",
  WALK_IN: "Walk-in",
  REFERRAL: "Referral",
};
export const STATUS_LABELS: Record<ScheduleStatus, string> = {
  BOOKED: "Booked",
  CHECKED_IN: "Checked in",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  NO_SHOW: "Did not attend",
  RESCHEDULED: "Moved",
};
/** Reuses the console's state badge colours. */
export const STATUS_CLASS: Record<ScheduleStatus, string> = {
  BOOKED: "state--progress",
  CHECKED_IN: "state--attention",
  COMPLETED: "state--booked",
  CANCELLED: "state--closed",
  NO_SHOW: "state--exception",
  RESCHEDULED: "state--closed",
};
export const CANCEL_REASONS = [
  ["PATIENT_REQUEST", "Patient asked to cancel"],
  ["PRACTICE_REQUEST", "Practice cancelled"],
  ["PRACTITIONER_UNAVAILABLE", "Doctor unavailable"],
  ["DUPLICATE_BOOKING", "Booked twice"],
  ["OTHER", "Other"],
] as const;

function parts(at: Date, timezone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return p as Record<"year" | "month" | "day" | "hour" | "minute", string>;
}
/** YYYY-MM-DD of an instant in a time zone. */
export function localDate(at: Date, timezone: string): string {
  const p = parts(at, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}
/** Minutes since local midnight of an instant in a time zone. */
export function localMinutes(at: Date, timezone: string): number {
  const p = parts(at, timezone);
  return Number(p.hour) * 60 + Number(p.minute);
}
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/** ISO weekday (1 = Monday) of a calendar date. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
export function weekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}
/** 24-hour local time, as the practice reads its diary. */
export function clock(at: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
}
export function stampIn(at: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
}
export function dayTitle(
  date: string,
  style: "long" | "short" = "long",
): string {
  return new Intl.DateTimeFormat([], {
    timeZone: "UTC",
    weekday: style,
    day: "numeric",
    month: style,
  }).format(new Date(`${date}T12:00:00Z`));
}
export function minutesLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
export function patientName(a: ScheduledAppointment): string {
  return a.patient
    ? `${a.patient.given_name} ${a.patient.family_name}`
    : "Patient details hidden";
}
/** Statuses still on the day's list of people to see. */
export function isLive(status: ScheduleStatus): boolean {
  return status === "BOOKED" || status === "CHECKED_IN";
}
