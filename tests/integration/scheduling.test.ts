import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { seedPractitioner, tenantTx } from "../../packages/db/src/index.js";
import {
  caseState,
  closePools,
  databaseEnabled,
  dispatcher,
  drain,
  ingest,
  mock,
  newTenant,
  ownerPool,
  staff,
  testApi,
  workerPool,
  type TestApi,
} from "../support/harness.js";

/**
 * Native scheduling against real PostgreSQL through the API (access_request
 * role, row-level security on). The clock is fixed to Monday 2 November 2026,
 * 07:00 in Johannesburg (05:00Z), before Dr M's first session at 08:00.
 */
const MONDAY = "2026-11-02";
let clock = new Date("2026-11-02T05:00:00Z");
/** Local Johannesburg wall time (UTC+2, no daylight saving) on the Monday. */
const at = (hhmm: string, day = MONDAY) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(
    `${day}T${String(h! - 2).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`,
  ).toISOString();
};
const RECEPTION = "REFERRAL_COORDINATOR";

describe.runIf(databaseEnabled)("native scheduling (PostgreSQL, API)", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await testApi({ now: () => clock });
  });
  afterAll(async () => {
    await t.close();
    await closePools();
  });

  async function practice() {
    const tenant = await newTenant();
    const drM = randomUUID();
    const drX = randomUUID();
    await seedPractitioner(ownerPool(), {
      tenantId: tenant,
      id: drM,
      displayName: "Dr M",
      linkedActorId: "synthetic:dr-m",
    });
    await seedPractitioner(ownerPool(), {
      tenantId: tenant,
      id: drX,
      displayName: "Dr X",
      linkedActorId: "synthetic:dr-x",
    });
    return { tenant, drM, drX };
  }
  const req = (
    tenant: string,
    method: "GET" | "POST",
    url: string,
    payload?: object,
    role = RECEPTION,
    user = "reception-1",
  ) =>
    t.app.inject({
      method,
      url,
      headers: staff(tenant, role, user),
      ...(payload ? { payload } : {}),
    });
  const phoneBooking = (
    practitionerId: string,
    startsAt: string,
    extra: object = {},
  ) => ({
    channel: "TELEPHONE",
    command_id: randomUUID(),
    practitioner_id: practitionerId,
    starts_at: startsAt,
    patient: {
      given_name: "Synthetic",
      family_name: `Caller ${randomUUID().slice(0, 4)}`,
      date_of_birth: "1980-01-01",
      phone: "+27 11 000 0000",
    },
    reason: "Synthetic follow-up",
    ...extra,
  });
  const book = (tenant: string, body: object, user = "reception-1") =>
    req(tenant, "POST", "/v1/schedule/appointments", body, RECEPTION, user);
  const act = (
    tenant: string,
    id: string,
    body: object,
    role = RECEPTION,
    user = "reception-1",
  ) =>
    req(
      tenant,
      "POST",
      `/v1/schedule/appointments/${id}/actions`,
      { command_id: randomUUID(), ...body },
      role,
      user,
    );
  const occupying = async (tenant: string) =>
    (
      await ownerPool().query(
        "SELECT starts_at,ends_at FROM scheduled_appointments WHERE tenant_id=$1 AND status IN ('BOOKED','CHECKED_IN','COMPLETED') ORDER BY starts_at",
        [tenant],
      )
    ).rows;

  describe("configuration and availability", () => {
    it("a practice manager sets up a practitioner's week; reception sees the free slots", async () => {
      const tenant = await newTenant();
      const created = await req(
        tenant,
        "POST",
        "/v1/schedule/practitioners",
        {
          command_id: randomUUID(),
          display_name: "Dr M",
          timezone: "Africa/Johannesburg",
          linked_actor_id: "synthetic:dr-m",
        },
        "PRACTICE_MANAGER",
      );
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().practitioner_id;
      const hours = await req(
        tenant,
        "POST",
        `/v1/schedule/practitioners/${id}/working-hours`,
        {
          command_id: randomUUID(),
          sessions: [
            { weekday: 1, start: "08:00", end: "10:00" },
            { weekday: 1, start: "11:00", end: "12:00" },
          ],
        },
        "PRACTICE_MANAGER",
      );
      expect(hours.statusCode, hours.body).toBe(200);
      const free = await req(
        tenant,
        "GET",
        `/v1/schedule/practitioners/${id}/availability?from=${MONDAY}&to=${MONDAY}`,
      );
      expect(free.statusCode, free.body).toBe(200);
      const slots = free
        .json()
        .slots.map((s: { starts_at: string }) => s.starts_at);
      // 08:00-10:00 and 11:00-12:00 in 15-minute appointments: 8 + 4.
      expect(slots).toHaveLength(12);
      expect(slots[0]).toBe(at("08:00"));
      expect(slots).not.toContain(at("10:00"));
      expect(slots).toContain(at("11:45"));
      // Tuesday has no hours.
      const tuesday = await req(
        tenant,
        "GET",
        `/v1/schedule/practitioners/${id}/availability?from=2026-11-03&to=2026-11-03`,
      );
      expect(tuesday.json().slots).toEqual([]);
    });

    it("refuses overlapping sessions, unknown time zones, and configuration by reception", async () => {
      const { tenant, drM } = await practice();
      const overlap = await req(
        tenant,
        "POST",
        `/v1/schedule/practitioners/${drM}/working-hours`,
        {
          command_id: randomUUID(),
          sessions: [
            { weekday: 2, start: "08:00", end: "10:00" },
            { weekday: 2, start: "09:30", end: "11:00" },
          ],
        },
        "PRACTICE_MANAGER",
      );
      expect(overlap.statusCode).toBe(422);
      expect(overlap.json().error).toBe("HOURS_INVALID");
      const zone = await req(
        tenant,
        "POST",
        "/v1/schedule/practitioners",
        {
          command_id: randomUUID(),
          display_name: "Dr Z",
          timezone: "Mars/Olympus",
        },
        "PRACTICE_MANAGER",
      );
      expect(zone.statusCode).toBe(422);
      expect(zone.json().error).toBe("TIMEZONE_INVALID");
      const byReception = await req(
        tenant,
        "POST",
        `/v1/schedule/practitioners/${drM}/blocks`,
        {
          command_id: randomUUID(),
          starts_at: at("08:00"),
          ends_at: at("09:00"),
          reason_code: "MEETING",
        },
      );
      expect(byReception.statusCode).toBe(403);
    });
  });

  describe("reception bookings", () => {
    it("books a telephone call and a walk-in without any referral; both appear on Dr M's calendar", async () => {
      const { tenant, drM } = await practice();
      const phone = await book(tenant, phoneBooking(drM, at("08:00")));
      expect(phone.statusCode, phone.body).toBe(201);
      expect(phone.json().appointment).toMatchObject({
        channel: "TELEPHONE",
        status: "BOOKED",
        starts_at: at("08:00"),
        ends_at: at("08:15"),
        referral_case_id: null,
        patient: { given_name: "Synthetic", phone: "+27 11 000 0000" },
      });
      const walkIn = await book(tenant, {
        channel: "WALK_IN",
        command_id: randomUUID(),
        practitioner_id: drM,
        starts_at: at("08:15"),
        duration_minutes: 30,
        patient: { given_name: "Synthetic", family_name: "Walker" },
      });
      expect(walkIn.statusCode, walkIn.body).toBe(201);
      const calendar = await req(
        tenant,
        "GET",
        `/v1/schedule/calendar?from=${MONDAY}&to=${MONDAY}`,
        undefined,
        "PRACTITIONER",
        "dr-m",
      );
      expect(calendar.statusCode, calendar.body).toBe(200);
      expect(
        calendar.json().appointments.map((a: { channel: string }) => a.channel),
      ).toEqual(["TELEPHONE", "WALK_IN"]);
      // The doctor sees who and why, not the phone number.
      expect(calendar.json().appointments[0].patient).toEqual({
        given_name: "Synthetic",
        family_name: phone.json().appointment.patient.family_name,
        date_of_birth: "1980-01-01",
      });
    });

    it("a telephone booking needs a number to call back; the referral is never required", async () => {
      const { tenant, drM } = await practice();
      const body = phoneBooking(drM, at("09:00"));
      const noPhone = await book(tenant, {
        ...body,
        patient: { given_name: "Synthetic", family_name: "Patient" },
      });
      expect(noPhone.statusCode).toBe(400);
      const withReferral = await book(tenant, {
        ...body,
        referral_case_id: randomUUID(),
      });
      expect(withReferral.statusCode).toBe(400);
    });

    it("refuses double booking: the same time, a partial overlap; the adjacent slot is free", async () => {
      const { tenant, drM, drX } = await practice();
      expect(
        (
          await book(
            tenant,
            phoneBooking(drM, at("08:00"), { duration_minutes: 30 }),
          )
        ).statusCode,
      ).toBe(201);
      const same = await book(tenant, phoneBooking(drM, at("08:00")));
      expect(same.statusCode).toBe(409);
      expect(same.json()).toEqual({
        error: "SLOT_UNAVAILABLE",
        message: "that time is no longer free for this practitioner",
      });
      expect(
        (await book(tenant, phoneBooking(drM, at("08:15")))).statusCode,
      ).toBe(409);
      expect(
        (await book(tenant, phoneBooking(drM, at("08:30")))).statusCode,
      ).toBe(201);
      // Another practitioner's time is independent.
      expect(
        (await book(tenant, phoneBooking(drX, at("08:00")))).statusCode,
      ).toBe(201);
      // The free slots no longer offer the taken times.
      const free = await req(
        tenant,
        "GET",
        `/v1/schedule/practitioners/${drM}/availability?from=${MONDAY}&to=${MONDAY}`,
      );
      const starts = free
        .json()
        .slots.map((s: { starts_at: string }) => s.starts_at);
      expect(starts).not.toContain(at("08:00"));
      expect(starts).not.toContain(at("08:30"));
      expect(starts).toContain(at("08:45"));
    });

    it("refuses times outside working hours, in the past, off the minute, and in blocked periods", async () => {
      const { tenant, drM } = await practice();
      const outside = await book(tenant, phoneBooking(drM, at("12:30")));
      expect(outside.json().error).toBe("OUTSIDE_WORKING_HOURS");
      const spill = await book(
        tenant,
        phoneBooking(drM, at("12:15"), { duration_minutes: 30 }),
      );
      expect(spill.json().error).toBe("OUTSIDE_WORKING_HOURS");
      const past = await book(
        tenant,
        phoneBooking(drM, at("08:00", "2026-10-26")),
      );
      expect(past.json().error).toBe("TIME_IN_PAST");
      const odd = await book(
        tenant,
        phoneBooking(
          drM,
          new Date(Date.parse(at("09:00")) + 30_000).toISOString(),
        ),
      );
      expect(odd.json().error).toBe("TIME_INVALID");
      const block = await req(
        tenant,
        "POST",
        `/v1/schedule/practitioners/${drM}/blocks`,
        {
          command_id: randomUUID(),
          starts_at: at("10:00"),
          ends_at: at("11:00"),
          reason_code: "MEETING",
        },
        "PRACTICE_MANAGER",
      );
      expect(block.statusCode, block.body).toBe(201);
      const blocked = await book(tenant, phoneBooking(drM, at("10:30")));
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json().error).toBe("TIME_BLOCKED");
      // A block may not cover a booked appointment; removing it frees the time.
      expect(
        (await book(tenant, phoneBooking(drM, at("11:00")))).statusCode,
      ).toBe(201);
      const over = await req(
        tenant,
        "POST",
        `/v1/schedule/practitioners/${drM}/blocks`,
        {
          command_id: randomUUID(),
          starts_at: at("11:00"),
          ends_at: at("12:00"),
          reason_code: "LEAVE",
        },
        "PRACTICE_MANAGER",
      );
      expect(over.statusCode).toBe(409);
      expect(over.json().error).toBe("BLOCK_OVERLAPS_APPOINTMENTS");
      const removed = await req(
        tenant,
        "POST",
        `/v1/schedule/practitioners/${drM}/blocks/${block.json().block_id}/remove`,
        { command_id: randomUUID() },
        "PRACTICE_MANAGER",
      );
      expect(removed.statusCode, removed.body).toBe(200);
      expect(
        (await book(tenant, phoneBooking(drM, at("10:30")))).statusCode,
      ).toBe(201);
    });

    it("a retried booking (lost response) returns the same appointment; a reused command_id with other content is refused", async () => {
      const { tenant, drM } = await practice();
      const body = phoneBooking(drM, at("09:00"));
      const first = await book(tenant, body);
      const retry = await book(tenant, body);
      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toMatchObject({
        deduplicated: true,
        appointment_id: first.json().appointment_id,
      });
      const reused = await book(tenant, { ...body, starts_at: at("09:15") });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().error).toBe("IDEMPOTENCY_CONFLICT");
      expect(await occupying(tenant)).toHaveLength(1);
      // The stored command result names the appointment, never the patient.
      const stored = await ownerPool().query(
        "SELECT result_json::text AS r FROM commands WHERE tenant_id=$1 AND command_id=$2",
        [tenant, body.command_id],
      );
      expect(stored.rows[0].r).not.toContain("Synthetic");
      expect(stored.rows[0].r).not.toContain("+27");
    });
  });

  describe("simultaneous reception requests", () => {
    it("ten receptionists booking the same slot at once: exactly one succeeds", async () => {
      const { tenant, drM } = await practice();
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          book(tenant, phoneBooking(drM, at("09:00")), `reception-${i}`),
        ),
      );
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes.filter((c) => c === 201)).toHaveLength(1);
      expect(codes.filter((c) => c === 409)).toHaveLength(9);
      for (const r of results.filter((x) => x.statusCode === 409))
        expect(r.json().error).toBe("SLOT_UNAVAILABLE");
      expect(await occupying(tenant)).toHaveLength(1);
    });

    it("overlapping requests at different start times never produce overlapping appointments", async () => {
      const { tenant, drM } = await practice();
      const starts = ["09:00", "09:05", "09:10", "09:15", "09:20", "09:30"];
      await Promise.all(
        starts.map((s, i) =>
          book(
            tenant,
            phoneBooking(drM, at(s), { duration_minutes: 20 }),
            `reception-${i}`,
          ),
        ),
      );
      const rows = await occupying(tenant);
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (let i = 1; i < rows.length; i++)
        expect(new Date(rows[i].starts_at).getTime()).toBeGreaterThanOrEqual(
          new Date(rows[i - 1].ends_at).getTime(),
        );
    });

    it("a reschedule and a new booking racing for the same time: one wins, nothing is lost", async () => {
      const { tenant, drM } = await practice();
      const original = (
        await book(tenant, phoneBooking(drM, at("08:00")))
      ).json().appointment;
      const [moved, booked] = await Promise.all([
        act(tenant, original.id, {
          action: "reschedule",
          expected_version: 0,
          starts_at: at("09:00"),
        }),
        book(tenant, phoneBooking(drM, at("09:00")), "reception-2"),
      ]);
      const won = [moved.statusCode === 200, booked.statusCode === 201];
      expect(won.filter(Boolean)).toHaveLength(1);
      expect(won[0] ? booked.statusCode : moved.statusCode).toBe(409);
      const rows = await ownerPool().query(
        "SELECT status,starts_at FROM scheduled_appointments WHERE tenant_id=$1 ORDER BY created_at",
        [tenant],
      );
      // Either the move won (original RESCHEDULED + replacement at 09:00) or
      // the new booking won (original still BOOKED at 08:00).
      const live = rows.rows.filter((r) => r.status === "BOOKED");
      expect(live).toHaveLength(2);
      expect(
        live.filter((r) => new Date(r.starts_at).toISOString() === at("09:00")),
      ).toHaveLength(1);
    });
  });

  describe("rescheduling, cancellation and the day's statuses", () => {
    it("reschedules as a linked replacement, may overlap its own old time, keeps history", async () => {
      const { tenant, drM } = await practice();
      const a = (
        await book(
          tenant,
          phoneBooking(drM, at("08:00"), { duration_minutes: 30 }),
        )
      ).json().appointment;
      const moved = await act(tenant, a.id, {
        action: "reschedule",
        expected_version: 0,
        starts_at: at("08:15"),
      });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(moved.json()).toMatchObject({
        previous_appointment_id: a.id,
        status: "BOOKED",
      });
      const replacement = moved.json().appointment;
      expect(replacement).toMatchObject({
        starts_at: at("08:15"),
        ends_at: at("08:45"),
        rescheduled_from_id: a.id,
        version: 0,
      });
      const old = await req(tenant, "GET", `/v1/schedule/appointments/${a.id}`);
      expect(old.json().appointment).toMatchObject({
        status: "RESCHEDULED",
        rescheduled_to_id: replacement.id,
      });
      expect(
        old.json().history.map((h: { event_type: string }) => h.event_type),
      ).toEqual(["BOOKED", "RESCHEDULED"]);
      // The old time is free again; the calendar shows only the replacement.
      expect(
        (await book(tenant, phoneBooking(drM, at("08:00")))).statusCode,
      ).toBe(201);
      const cal = await req(
        tenant,
        "GET",
        `/v1/schedule/calendar?practitioner_id=${drM}&from=${MONDAY}&to=${MONDAY}`,
      );
      expect(
        cal.json().appointments.map((x: { id: string }) => x.id),
      ).not.toContain(a.id);
    });

    it("a reschedule into a taken time is refused and the original stays exactly as it was", async () => {
      const { tenant, drM } = await practice();
      const a = (await book(tenant, phoneBooking(drM, at("08:00")))).json()
        .appointment;
      await book(tenant, phoneBooking(drM, at("09:00")));
      const refused = await act(tenant, a.id, {
        action: "reschedule",
        expected_version: 0,
        starts_at: at("09:00"),
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("SLOT_UNAVAILABLE");
      const after = await req(
        tenant,
        "GET",
        `/v1/schedule/appointments/${a.id}`,
      );
      expect(after.json().appointment).toMatchObject({
        status: "BOOKED",
        version: 0,
        rescheduled_to_id: null,
      });
      expect(after.json().history).toHaveLength(1);
      const stale = await act(tenant, a.id, {
        action: "cancel",
        expected_version: 3,
        reason_code: "PATIENT_REQUEST",
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toBe("VERSION_CONFLICT");
    });

    it("cancellation frees the time; a cancelled appointment cannot change again", async () => {
      const { tenant, drM } = await practice();
      const a = (await book(tenant, phoneBooking(drM, at("10:00")))).json()
        .appointment;
      const cancelled = await act(tenant, a.id, {
        action: "cancel",
        expected_version: 0,
        reason_code: "PATIENT_REQUEST",
      });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      expect(cancelled.json().appointment).toMatchObject({
        status: "CANCELLED",
        cancellation_reason_code: "PATIENT_REQUEST",
      });
      expect(
        (await book(tenant, phoneBooking(drM, at("10:00")))).statusCode,
      ).toBe(201);
      const again = await act(tenant, a.id, {
        action: "check_in",
        expected_version: 1,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("INVALID_TRANSITION");
    });

    it("check-in, completion by Dr M, no-show only once due, and a late arrival", async () => {
      const { tenant, drM } = await practice();
      const a = (await book(tenant, phoneBooking(drM, at("08:00")))).json()
        .appointment;
      const b = (await book(tenant, phoneBooking(drM, at("08:15")))).json()
        .appointment;
      const early = await act(tenant, b.id, {
        action: "no_show",
        expected_version: 0,
      });
      expect(early.json().error).toBe("NOT_YET_DUE");
      expect(
        (await act(tenant, a.id, { action: "check_in", expected_version: 0 }))
          .statusCode,
      ).toBe(200);
      clock = new Date(Date.parse(at("08:20")));
      try {
        const done = await act(
          tenant,
          a.id,
          { action: "complete", expected_version: 1 },
          "PRACTITIONER",
          "dr-m",
        );
        expect(done.statusCode, done.body).toBe(200);
        expect(done.json().appointment.status).toBe("COMPLETED");
        expect(
          (
            await act(tenant, b.id, { action: "no_show", expected_version: 0 })
          ).json().appointment.status,
        ).toBe("NO_SHOW");
        const late = await act(tenant, b.id, {
          action: "check_in",
          expected_version: 1,
        });
        expect(late.json().appointment.status).toBe("CHECKED_IN");
      } finally {
        clock = new Date("2026-11-02T05:00:00Z");
      }
    });
  });

  describe("referral bookings (the ACCESS-DTM pipeline stays intact)", () => {
    async function readyReferral(tenant: string) {
      const r = await ingest(t, tenant);
      await drain(dispatcher([tenant], mock()));
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      return r;
    }
    it("books a ready referral: patient taken from the referral, referral BOOKED in the same transaction", async () => {
      const { tenant, drM } = await practice();
      const r = await readyReferral(tenant);
      const res = await book(tenant, {
        channel: "REFERRAL",
        command_id: randomUUID(),
        practitioner_id: drM,
        starts_at: at("09:00"),
        referral_case_id: r.case_id,
        phone: "+27 11 000 0001",
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().appointment).toMatchObject({
        channel: "REFERRAL",
        referral_case_id: r.case_id,
        patient: {
          given_name: "Synthetic",
          family_name: "Patient",
          date_of_birth: "1980-01-01",
          identifier: "SYN-001",
        },
      });
      expect((await caseState(r.case_id)).current_state).toBe("BOOKED");
      const again = await book(tenant, {
        channel: "REFERRAL",
        command_id: randomUUID(),
        practitioner_id: drM,
        starts_at: at("10:00"),
        referral_case_id: r.case_id,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json().error).toBe("REFERRAL_NOT_BOOKABLE");
    });

    it("refuses a referral that is not ready, and a time that is taken leaves the referral untouched", async () => {
      const { tenant, drM } = await practice();
      const notReady = await ingest(t, tenant, {
        fixture: "missing-insurance",
      });
      const refused = await book(tenant, {
        channel: "REFERRAL",
        command_id: randomUUID(),
        practitioner_id: drM,
        starts_at: at("09:00"),
        referral_case_id: notReady.case_id,
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("REFERRAL_NOT_BOOKABLE");
      const r = await readyReferral(tenant);
      await book(tenant, phoneBooking(drM, at("11:00")));
      const taken = await book(tenant, {
        channel: "REFERRAL",
        command_id: randomUUID(),
        practitioner_id: drM,
        starts_at: at("11:00"),
        referral_case_id: r.case_id,
      });
      expect(taken.statusCode).toBe(409);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
    });

    it("two receptionists booking the same referral at different times: one appointment", async () => {
      const { tenant, drM } = await practice();
      const r = await readyReferral(tenant);
      const body = (time: string) => ({
        channel: "REFERRAL",
        command_id: randomUUID(),
        practitioner_id: drM,
        starts_at: at(time),
        referral_case_id: r.case_id,
      });
      const results = await Promise.all([
        book(tenant, body("09:00"), "a"),
        book(tenant, body("10:00"), "b"),
      ]);
      expect(results.map((x) => x.statusCode).sort()).toEqual([201, 409]);
      const rows = await ownerPool().query(
        "SELECT count(*)::int n FROM scheduled_appointments WHERE tenant_id=$1",
        [tenant],
      );
      expect(rows.rows[0].n).toBe(1);
    });

    it("cancelling a referral appointment raises the BOOKED referral for review", async () => {
      const { tenant, drM } = await practice();
      const r = await readyReferral(tenant);
      const a = (
        await book(tenant, {
          channel: "REFERRAL",
          command_id: randomUUID(),
          practitioner_id: drM,
          starts_at: at("09:00"),
          referral_case_id: r.case_id,
        })
      ).json().appointment;
      // The patient calls to cancel an hour after booking.
      clock = new Date(clock.getTime() + 3600_000);
      try {
        expect(
          (
            await act(tenant, a.id, {
              action: "cancel",
              expected_version: 0,
              reason_code: "PATIENT_REQUEST",
            })
          ).statusCode,
        ).toBe(200);
      } finally {
        clock = new Date("2026-11-02T05:00:00Z");
      }
      const work = await ownerPool().query(
        "SELECT kind FROM work_items WHERE tenant_id=$1 AND case_id=$2 AND status='OPEN'",
        [tenant, r.case_id],
      );
      expect(work.rows.length).toBeGreaterThan(0);
      const obs = await ownerPool().query(
        "SELECT observation_type,disposition FROM access_case_observations WHERE tenant_id=$1 AND case_id=$2 ORDER BY recorded_at",
        [tenant, r.case_id],
      );
      expect(
        obs.rows.map((o) => `${o.observation_type}:${o.disposition}`),
      ).toEqual(
        expect.arrayContaining([
          "APPOINTMENT_BOOKED:APPLIED",
          "APPOINTMENT_CANCELLED:REVIEW",
        ]),
      );
    });
  });

  describe("security", () => {
    it("Dr M sees only his own calendar and appointments; never another practitioner's", async () => {
      const { tenant, drM, drX } = await practice();
      const mine = (await book(tenant, phoneBooking(drM, at("08:00")))).json()
        .appointment;
      const theirs = (await book(tenant, phoneBooking(drX, at("08:00")))).json()
        .appointment;
      const own = await req(
        tenant,
        "GET",
        `/v1/schedule/calendar?from=${MONDAY}&to=${MONDAY}`,
        undefined,
        "PRACTITIONER",
        "dr-m",
      );
      expect(own.json().practitioner.id).toBe(drM);
      expect(own.json().appointments.map((a: { id: string }) => a.id)).toEqual([
        mine.id,
      ]);
      const other = await req(
        tenant,
        "GET",
        `/v1/schedule/calendar?practitioner_id=${drX}&from=${MONDAY}&to=${MONDAY}`,
        undefined,
        "PRACTITIONER",
        "dr-m",
      );
      expect(other.statusCode).toBe(404);
      const peek = await req(
        tenant,
        "GET",
        `/v1/schedule/appointments/${theirs.id}`,
        undefined,
        "PRACTITIONER",
        "dr-m",
      );
      expect(peek.statusCode).toBe(404);
      const list = await req(
        tenant,
        "GET",
        "/v1/schedule/practitioners",
        undefined,
        "PRACTITIONER",
        "dr-m",
      );
      expect(list.json().map((p: { id: string }) => p.id)).toEqual([drM]);
      // An unlinked practitioner login sees nothing at all.
      const stranger = await req(
        tenant,
        "GET",
        `/v1/schedule/calendar?from=${MONDAY}&to=${MONDAY}`,
        undefined,
        "PRACTITIONER",
        "dr-nobody",
      );
      expect(stranger.statusCode).toBe(404);
      // Completing someone else's appointment finds nothing.
      const steal = await act(
        tenant,
        theirs.id,
        { action: "complete", expected_version: 0 },
        "PRACTITIONER",
        "dr-m",
      );
      expect(steal.statusCode).toBe(404);
    });

    it("a practitioner cannot book, change, configure or read the referral queue", async () => {
      const { tenant, drM } = await practice();
      const a = (await book(tenant, phoneBooking(drM, at("08:00")))).json()
        .appointment;
      const asDoctor = (method: "GET" | "POST", url: string, body?: object) =>
        req(tenant, method, url, body, "PRACTITIONER", "dr-m");
      expect(
        (
          await asDoctor(
            "POST",
            "/v1/schedule/appointments",
            phoneBooking(drM, at("09:00")),
          )
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await asDoctor("POST", `/v1/schedule/appointments/${a.id}/actions`, {
            action: "cancel",
            command_id: randomUUID(),
            expected_version: 0,
            reason_code: "OTHER",
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await asDoctor("POST", `/v1/schedule/practitioners/${drM}/blocks`, {
            command_id: randomUUID(),
            starts_at: at("10:00"),
            ends_at: at("11:00"),
            reason_code: "LEAVE",
          })
        ).statusCode,
      ).toBe(403);
      expect((await asDoctor("GET", "/v1/cases?filter=all")).statusCode).toBe(
        403,
      );
      expect(
        (
          await asDoctor(
            "GET",
            `/v1/schedule/practitioners/${drM}/availability?from=${MONDAY}&to=${MONDAY}`,
          )
        ).statusCode,
      ).toBe(403);
    });

    it("read-only staff see the calendar's shape without patient details; other organisations see nothing", async () => {
      const { tenant, drM } = await practice();
      await book(tenant, phoneBooking(drM, at("08:00")));
      const ro = await req(
        tenant,
        "GET",
        `/v1/schedule/calendar?practitioner_id=${drM}&from=${MONDAY}&to=${MONDAY}`,
        undefined,
        "READ_ONLY",
      );
      expect(ro.statusCode).toBe(200);
      expect(ro.json().appointments[0]).toMatchObject({
        patient: null,
        reason: null,
        status: "BOOKED",
      });
      expect(JSON.stringify(ro.json())).not.toContain("Synthetic");
      const outsider = await newTenant();
      const cross = await req(
        outsider,
        "GET",
        `/v1/schedule/calendar?practitioner_id=${drM}&from=${MONDAY}&to=${MONDAY}`,
      );
      expect(cross.statusCode).toBe(404);
      const crossBook = await book(outsider, phoneBooking(drM, at("09:00")));
      expect(crossBook.statusCode).toBe(404);
    });

    it("row-level security scopes a practitioner session in the database itself", async () => {
      const { tenant, drM, drX } = await practice();
      await book(tenant, phoneBooking(drM, at("08:00")));
      await book(tenant, phoneBooking(drX, at("08:00")));
      const { apiPool } = await import("../support/harness.js");
      const count = (
        actorRole: "PRACTITIONER" | "REFERRAL_COORDINATOR",
        actorId: string,
      ) =>
        tenantTx(
          tenant,
          async (c) =>
            (
              await c.query(
                "SELECT practitioner_id FROM scheduled_appointments",
              )
            ).rows.map((r) => r.practitioner_id),
          apiPool(),
          { actorRole, actorId },
        );
      expect(await count("PRACTITIONER", "synthetic:dr-m")).toEqual([drM]);
      expect(
        (await count("REFERRAL_COORDINATOR", "synthetic:reception")).sort(),
      ).toEqual([drM, drX].sort());
      // No tenant context: nothing. The worker login has no access at all.
      const c = await apiPool().connect();
      try {
        expect(
          (await c.query("SELECT count(*)::int n FROM scheduled_appointments"))
            .rows[0].n,
        ).toBe(0);
      } finally {
        c.release();
      }
      await expect(
        workerPool().query("SELECT 1 FROM scheduled_appointments LIMIT 1"),
      ).rejects.toThrow(/permission denied/);
    });

    it("PostgreSQL itself refuses overlap, deletion, rewriting a booking and invalid transitions", async () => {
      const { tenant, drM } = await practice();
      const a = (
        await book(
          tenant,
          phoneBooking(drM, at("08:00"), { duration_minutes: 30 }),
        )
      ).json().appointment;
      const owner = ownerPool();
      const insert = (start: string, end: string) =>
        owner.query(
          `INSERT INTO scheduled_appointments(tenant_id,id,practitioner_id,booking_channel,patient_given_name,patient_family_name,
                                              status,starts_at,ends_at,duration_minutes,timezone,booked_by,booked_role)
           VALUES($1,$2,$3,'WALK_IN','Synthetic','Direct','BOOKED',$4,$5,(extract(epoch FROM ($5::timestamptz - $4::timestamptz))/60)::int,
                  'Africa/Johannesburg','test','ADMIN')`,
          [tenant, randomUUID(), drM, start, end],
        );
      await expect(insert(at("08:15"), at("08:45"))).rejects.toMatchObject({
        code: "23P01",
      });
      await expect(
        owner.query("DELETE FROM scheduled_appointments WHERE id=$1", [a.id]),
      ).rejects.toThrow(/never deleted/);
      await expect(
        owner.query(
          "UPDATE scheduled_appointments SET starts_at=starts_at + interval '1 hour', version=version+1 WHERE id=$1",
          [a.id],
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        owner.query(
          "UPDATE scheduled_appointments SET status='COMPLETED', completed_at=now(), completed_by='x', version=version+1 WHERE id=$1",
          [a.id],
        ),
      ).rejects.toThrow(/invalid appointment transition/);
      await expect(
        owner.query(
          "UPDATE scheduled_appointment_events SET actor_id='x' WHERE appointment_id=$1",
          [a.id],
        ),
      ).rejects.toThrow();
    });
  });
});
