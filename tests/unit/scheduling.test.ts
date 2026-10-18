import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  bookAppointmentSchema,
  SCHEDULE_STATUSES,
  scheduleChangeSchema,
  scheduleRangeSchema,
  workingHoursSchema,
} from "../../packages/contracts/src/index.js";
import {
  canScheduleTransition,
  clockMinutes,
  SCHEDULE_TRANSITIONS,
  scheduleChangeTarget,
  workingSessions,
} from "../../packages/domain/src/index.js";

const id = "00000000-0000-4000-8000-000000000001";

describe("native scheduling rules", () => {
  it("the TypeScript state machine is exactly the database's", async () => {
    const sql = await readFile(
      "supabase/migrations/0007_native_scheduling.sql",
      "utf8",
    );
    const body = sql.slice(
      sql.indexOf("scheduled_appointment_transition_allowed"),
    );
    const pairs = [
      ...body
        .slice(0, body.indexOf("$$;"))
        .matchAll(/\('([A-Z_]+)','([A-Z_]+)'\)/g),
    ].map((m) => `${m[1]}>${m[2]}`);
    const ts = Object.entries(SCHEDULE_TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((to) => `${from}>${to}`),
    );
    expect(pairs.sort()).toEqual(ts.sort());
    expect(Object.keys(SCHEDULE_TRANSITIONS).sort()).toEqual(
      [...SCHEDULE_STATUSES].sort(),
    );
  });

  it("finished appointments never change; a late arrival may still be checked in", () => {
    for (const end of ["COMPLETED", "CANCELLED", "RESCHEDULED"] as const)
      for (const to of SCHEDULE_STATUSES)
        expect(canScheduleTransition(end, to)).toBe(false);
    expect(canScheduleTransition("NO_SHOW", "CHECKED_IN")).toBe(true);
    expect(canScheduleTransition("BOOKED", "COMPLETED")).toBe(false);
    expect(scheduleChangeTarget("reschedule")).toBe("RESCHEDULED");
    expect(scheduleChangeTarget("no_show")).toBe("NO_SHOW");
  });

  it("validates a weekly template: order, overlap and midnight", () => {
    expect(clockMinutes("08:30")).toBe(510);
    expect(clockMinutes("24:00")).toBe(1440);
    expect(
      workingSessions([
        { weekday: 1, start: "13:30", end: "17:00" },
        { weekday: 1, start: "08:00", end: "12:30" },
      ]),
    ).toEqual({
      ok: true,
      sessions: [
        { weekday: 1, start_minute: 480, end_minute: 750 },
        { weekday: 1, start_minute: 810, end_minute: 1020 },
      ],
    });
    expect(
      workingSessions([{ weekday: 2, start: "10:00", end: "09:00" }]).ok,
    ).toBe(false);
    expect(
      workingSessions([
        { weekday: 3, start: "08:00", end: "10:00" },
        { weekday: 3, start: "09:59", end: "11:00" },
      ]),
    ).toEqual({ ok: false, problem: "sessions overlap on weekday 3" });
    // Back-to-back sessions and the same times on different days are fine.
    expect(
      workingSessions([
        { weekday: 4, start: "08:00", end: "10:00" },
        { weekday: 4, start: "10:00", end: "12:00" },
        { weekday: 5, start: "08:00", end: "10:00" },
      ]).ok,
    ).toBe(true);
    expect(
      workingHoursSchema.safeParse({
        command_id: id,
        sessions: [{ weekday: 1, start: "8:00", end: "12:00" }],
      }).success,
    ).toBe(false);
  });

  it("a telephone booking needs a phone number, a walk-in does not, and a referral booking takes no patient from the browser", () => {
    const base = {
      command_id: id,
      practitioner_id: id,
      starts_at: "2026-11-02T07:00:00+02:00",
    };
    const patient = { given_name: "Synthetic", family_name: "Patient" };
    expect(
      bookAppointmentSchema.safeParse({
        ...base,
        channel: "TELEPHONE",
        patient,
      }).success,
    ).toBe(false);
    expect(
      bookAppointmentSchema.safeParse({
        ...base,
        channel: "TELEPHONE",
        patient: { ...patient, phone: "+27 11 000 0000" },
      }).success,
    ).toBe(true);
    expect(
      bookAppointmentSchema.safeParse({ ...base, channel: "WALK_IN", patient })
        .success,
    ).toBe(true);
    expect(
      bookAppointmentSchema.safeParse({
        ...base,
        channel: "REFERRAL",
        referral_case_id: id,
      }).success,
    ).toBe(true);
    expect(
      bookAppointmentSchema.safeParse({
        ...base,
        channel: "REFERRAL",
        referral_case_id: id,
        patient,
      }).success,
    ).toBe(false);
    expect(
      bookAppointmentSchema.safeParse({
        ...base,
        channel: "WALK_IN",
        patient: { ...patient, given_name: "Bad\u0007" },
      }).success,
    ).toBe(false);
    expect(
      bookAppointmentSchema.safeParse({
        ...base,
        channel: "WALK_IN",
        patient,
        duration_minutes: 600,
      }).success,
    ).toBe(false);
  });

  it("changes carry the version they expect; ranges are bounded", () => {
    expect(
      scheduleChangeSchema.safeParse({
        action: "cancel",
        command_id: id,
        reason_code: "OTHER",
      }).success,
    ).toBe(false);
    expect(
      scheduleChangeSchema.safeParse({
        action: "cancel",
        command_id: id,
        expected_version: 0,
        reason_code: "OTHER",
      }).success,
    ).toBe(true);
    expect(
      scheduleRangeSchema.safeParse({ from: "2026-11-02", to: "2026-11-08" })
        .success,
    ).toBe(true);
    expect(
      scheduleRangeSchema.safeParse({ from: "2026-11-08", to: "2026-11-02" })
        .success,
    ).toBe(false);
    expect(
      scheduleRangeSchema.safeParse({ from: "2026-11-01", to: "2027-01-01" })
        .success,
    ).toBe(false);
  });
});
