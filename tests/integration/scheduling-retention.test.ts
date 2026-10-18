import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  purgeSchedule,
  seedPractitioner,
  tenantTx,
} from "../../packages/db/src/index.js";
import {
  closePools,
  databaseEnabled,
  newTenant,
  ownerPool,
  staff,
  testApi,
  type TestApi,
} from "../support/harness.js";

/**
 * The operator retention purge: finished appointments past the cutoff go,
 * whole reschedule chains only; anything live stays; the guards come back.
 * Bookings are made on Monday 2 November 2026 (Johannesburg, UTC+2).
 */
const day = (d: string, hhmm: string) =>
  new Date(`${d}T${hhmm}:00+02:00`).toISOString();
let clock = new Date("2026-11-02T05:00:00Z");
const RECEPTION = "REFERRAL_COORDINATOR";

describe.runIf(databaseEnabled)("scheduling retention purge", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await testApi({ now: () => clock });
  });
  afterAll(async () => {
    await t.close();
    await closePools();
  });

  const req = (
    tenant: string,
    url: string,
    payload: object,
    role = RECEPTION,
  ) =>
    t.app.inject({
      method: "POST",
      url,
      headers: staff(tenant, role, "reception-1"),
      payload,
    });
  async function book(
    tenant: string,
    practitionerId: string,
    startsAt: string,
  ) {
    const r = await req(tenant, "/v1/schedule/appointments", {
      channel: "WALK_IN",
      command_id: randomUUID(),
      practitioner_id: practitionerId,
      starts_at: startsAt,
      patient: {
        given_name: "Synthetic",
        family_name: `Retention ${randomUUID().slice(0, 4)}`,
      },
    });
    expect(r.statusCode).toBe(201);
    return ref(r);
  }
  type Ref = { appointment_id: string; version: number };
  const ref = (r: { json(): unknown }): Ref => {
    const a = (r.json() as { appointment: { id: string; version: number } })
      .appointment;
    return { appointment_id: a.id, version: a.version };
  };
  const act = (
    tenant: string,
    id: string,
    version: number,
    body: object,
    role = RECEPTION,
  ) =>
    req(
      tenant,
      `/v1/schedule/appointments/${id}/actions`,
      {
        command_id: randomUUID(),
        expected_version: version,
        ...body,
      },
      role,
    );
  // The owner may bypass row-level security: filter by tenant explicitly.
  const count = async (tenant: string, table: string, where = "TRUE") =>
    Number(
      (
        await ownerPool().query(
          `SELECT count(*) n FROM ${table} WHERE tenant_id = $1 AND ${where}`,
          [tenant],
        )
      ).rows[0].n,
    );

  async function practice() {
    const tenant = await newTenant();
    const drM = randomUUID();
    await seedPractitioner(ownerPool(), {
      tenantId: tenant,
      id: drM,
      displayName: "Dr M",
      linkedActorId: "synthetic:dr-m",
    });
    clock = new Date("2026-11-02T05:00:00Z");
    const cancelled = await book(tenant, drM, day("2026-11-02", "08:00"));
    const cancel = await act(
      tenant,
      cancelled.appointment_id,
      cancelled.version,
      {
        action: "cancel",
        reason_code: "PATIENT_REQUEST",
      },
    );
    expect(cancel.json()).toMatchObject({ status: "CANCELLED" });
    // A chain moved twice; every link finished.
    const first = await book(tenant, drM, day("2026-11-02", "09:00"));
    const second = ref(
      await act(tenant, first.appointment_id, first.version, {
        action: "reschedule",
        starts_at: day("2026-11-02", "10:00"),
      }),
    );
    const third = ref(
      await act(tenant, second.appointment_id, second.version, {
        action: "reschedule",
        starts_at: day("2026-11-02", "11:00"),
      }),
    );
    // A chain whose replacement is still booked: it stays whole.
    const movedLive = await book(tenant, drM, day("2026-11-02", "13:30"));
    const liveReplacement = ref(
      await act(tenant, movedLive.appointment_id, movedLive.version, {
        action: "reschedule",
        starts_at: day("2026-11-02", "14:00"),
      }),
    );
    // Never resolved: still BOOKED although long past.
    const unresolved = await book(tenant, drM, day("2026-11-02", "15:00"));
    // After the cutoff.
    const later = await book(tenant, drM, day("2026-11-09", "08:00"));
    clock = new Date("2026-11-02T09:05:00Z"); // 11:05 local
    const t3 = await act(tenant, third.appointment_id, third.version, {
      action: "check_in",
    });
    expect(t3.statusCode).toBe(200);
    expect(
      (
        await act(tenant, third.appointment_id, ref(t3).version, {
          action: "complete",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await req(
          tenant,
          `/v1/schedule/practitioners/${drM}/blocks`,
          {
            command_id: randomUUID(),
            starts_at: day("2026-11-02", "16:00"),
            ends_at: day("2026-11-02", "16:30"),
            reason_code: "ADMIN",
          },
          "ADMIN",
        )
      ).statusCode,
    ).toBe(201);
    return {
      tenant,
      purged: [
        cancelled.appointment_id,
        first.appointment_id,
        second.appointment_id,
        third.appointment_id,
      ],
      kept: [
        movedLive.appointment_id,
        liveReplacement.appointment_id,
        unresolved.appointment_id,
        later.appointment_id,
      ],
    };
  }

  it("counts and rolls back without confirmation, then removes only finished chains past the cutoff", async () => {
    const p = await practice();
    const other = await practice();
    const before = new Date("2026-11-03T00:00:00+02:00");
    const now = new Date("2026-12-01T00:00:00Z");
    const total = () => count(p.tenant, "scheduled_appointments");
    expect(await total()).toBe(8);

    const dry = await purgeSchedule(ownerPool(), {
      tenantId: p.tenant,
      before,
      operator: "test",
      confirm: false,
      now,
    });
    expect(dry).toMatchObject({ appointments: 4, blocks: 1, committed: false });
    expect(dry.events).toBeGreaterThanOrEqual(6);
    expect(await total()).toBe(8);

    const done = await purgeSchedule(ownerPool(), {
      tenantId: p.tenant,
      before,
      operator: "ops ticket 1",
      confirm: true,
      now,
    });
    expect(done).toEqual({ ...dry, committed: true });
    const left = await tenantTx(
      p.tenant,
      async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT id FROM scheduled_appointments WHERE tenant_id = $1",
            [p.tenant],
          )
        ).rows.map((r) => r.id),
      ownerPool(),
      { actorRole: "ADMIN" },
    );
    expect(left.sort()).toEqual([...p.kept].sort());
    expect(
      await count(
        p.tenant,
        "scheduled_appointment_events",
        `appointment_id IN ('${p.purged.join("','")}')`,
      ),
    ).toBe(0);
    expect(await count(p.tenant, "practitioner_blocks")).toBe(0);
    // The other organisation is untouched.
    expect(await count(other.tenant, "scheduled_appointments")).toBe(8);
    // Recorded, with counts only.
    const audit = await tenantTx(
      p.tenant,
      async (c) =>
        (
          await c.query(
            "SELECT actor_id, payload FROM access_audit_log WHERE action='schedule.retention.purge' AND tenant_id = $1",
            [p.tenant],
          )
        ).rows,
      ownerPool(),
      { actorRole: "ADMIN" },
    );
    expect(audit).toEqual([
      {
        actor_id: "operator:ops ticket 1",
        payload: {
          before: before.toISOString(),
          appointments: 4,
          events: done.events,
          blocks: 1,
        },
      },
    ]);
    // The guards are back on, even for the owner.
    await expect(
      tenantTx(
        p.tenant,
        (c) => c.query("DELETE FROM scheduled_appointments"),
        ownerPool(),
        { actorRole: "ADMIN" },
      ),
    ).rejects.toThrow(/never deleted/);
    await expect(
      tenantTx(
        p.tenant,
        (c) => c.query("DELETE FROM scheduled_appointment_events"),
        ownerPool(),
        { actorRole: "ADMIN" },
      ),
    ).rejects.toThrow();
    // The calendar still works for what remains (it shows the replacement,
    // not the moved original).
    expect(
      (
        await t.app.inject({
          method: "GET",
          url: "/v1/schedule/calendar?from=2026-11-02&to=2026-11-09",
          headers: staff(p.tenant, "PRACTITIONER", "dr-m"),
        })
      ).json().appointments,
    ).toHaveLength(3);
  });

  it("refuses a recent cutoff and an unnamed operator, and the runtime roles cannot run it", async () => {
    const tenant = await newTenant();
    const now = new Date("2026-12-01T00:00:00Z");
    await expect(
      purgeSchedule(ownerPool(), {
        tenantId: tenant,
        before: new Date("2026-11-30T12:00:00Z"),
        operator: "x",
        confirm: true,
        now,
      }),
    ).rejects.toThrow(/a day in the past/);
    await expect(
      purgeSchedule(ownerPool(), {
        tenantId: tenant,
        before: new Date("2026-01-01T00:00:00Z"),
        operator: "",
        confirm: true,
        now,
      }),
    ).rejects.toThrow(/operator/);
    const { apiPool } = await import("../support/harness.js");
    await expect(
      purgeSchedule(apiPool(), {
        tenantId: tenant,
        before: new Date("2026-01-01T00:00:00Z"),
        operator: "x",
        confirm: true,
        now,
      }),
    ).rejects.toThrow(/owner|permission/);
  });
});
