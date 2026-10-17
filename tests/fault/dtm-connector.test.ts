import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type {
  ConnectorRequest,
  ReferralDelivery,
} from "../../packages/contracts/src/index.js";
import {
  AmbiguousConnectorError,
  CapabilityGate,
  PermanentConnectorError,
  SafeRetryableConnectorError,
  UnsupportedOperationError,
} from "../../apps/worker/src/connector.js";
import { DtmConnector } from "../../apps/worker/src/dtm-connector.js";
import { FakeDtm } from "../support/fake-dtm.js";

const tenantId = randomUUID();
const delivery: ReferralDelivery = {
  schema_version: "referral-delivery.v1",
  case_reference: "REF-1A2B3C4D",
  referral_id: randomUUID(),
  received_at: "2026-10-17T07:55:00.000Z",
  patient: {
    given_name: "Synthetic",
    family_name: "Patient",
    date_of_birth: "1980-01-01",
    identifier: "SYN-001",
  },
  referrer: { name: "Dr Fixture" },
  reason: "Synthetic knee assessment",
  documents_held: ["referral_letter"],
};
const request = (
  overrides: Partial<ConnectorRequest> = {},
): ConnectorRequest => ({
  schema_version: "connector-request.v1",
  execution_id: randomUUID(),
  tenant_id: tenantId,
  case_id: randomUUID(),
  subject: { type: "referral", id: delivery.referral_id },
  operation: "referral.create",
  correlation_id: randomUUID(),
  payload: { referral_id: delivery.referral_id, delivery },
  ...overrides,
});

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

let dtm: FakeDtm;
const connector = (overrides: Record<string, unknown> = {}) =>
  new DtmConnector({
    baseUrl: dtm.baseUrl,
    keyId: dtm.options.keyId,
    secret: dtm.options.secret,
    timeoutMs: 1_000,
    dataMode: "SYNTHETIC",
    ...overrides,
  });

beforeAll(async () => {
  dtm = await FakeDtm.start({ tenantId });
});
afterAll(async () => {
  await dtm.close();
});
beforeEach(() => {
  dtm.stored.clear();
  dtm.posts = 0;
});

describe("DTM connector: delivery", () => {
  it("delivers the referral in DTM's contract and returns the inbox reference", async () => {
    const r = request();
    expect(await connector().execute(r)).toEqual({
      schema_version: "connector-result.v1",
      execution_id: r.execution_id,
      status: "SUCCEEDED",
      external_id: "IN-000001",
    });
    // The fake applies DTM's strict schema: an unknown or missing field
    // would have been refused with 422.
    const referral: Record<string, unknown> = { ...delivery };
    delete referral.schema_version;
    expect(dtm.lastBody).toEqual({
      schema_version: "access-referral-delivery.v1",
      execution_id: r.execution_id,
      correlation_id: r.correlation_id,
      access_tenant_id: tenantId,
      data_mode: "SYNTHETIC",
      referral,
    });
    expect(dtm.lastHeaders?.["idempotency-key"]).toBe(r.execution_id);
  });

  it("a re-send of the same execution is stored once and answers the same reference", async () => {
    const r = request();
    const first = await connector().execute(r);
    const again = await connector().execute(r);
    expect(again).toEqual(first);
    expect(dtm.posts).toBe(2);
    expect(dtm.stored.size).toBe(1);
  });

  it("refusals before anything is stored are permanent, with DTM's reason", async () => {
    const cases: [() => Promise<unknown>, string][] = [
      [
        () =>
          connector({ secret: "another-secret-0123456789abcdefghij" }).execute(
            request(),
          ),
        "DTM_UNAUTHORISED",
      ],
      [
        () => connector().execute(request({ tenant_id: randomUUID() })),
        "DTM_TENANT_NOT_ALLOWED",
      ],
      [
        () => connector({ dataMode: "REAL" }).execute(request()),
        "DTM_DATA_MODE_MISMATCH",
      ],
    ];
    for (const [run, code] of cases)
      expect(await run()).toMatchObject({ status: "PERMANENT", code });
    dtm.failNext("disabled-503");
    expect(await connector().execute(request())).toMatchObject({
      status: "PERMANENT",
      code: "DTM_INTEGRATION_DISABLED",
    });
    dtm.failNext("redirect-307");
    expect(await connector().execute(request())).toMatchObject({
      status: "PERMANENT",
      code: "DTM_HTTP_307",
    });
    expect(dtm.stored.size).toBe(0);
  });

  it("a delivery DTM's schema refuses is permanent; nothing partial is ever sent", async () => {
    const bad = {
      ...delivery,
      patient: { ...delivery.patient, identifier: "#not-an-id" },
    };
    expect(
      await connector().execute(
        request({ payload: { referral_id: bad.referral_id, delivery: bad } }),
      ),
    ).toMatchObject({ status: "PERMANENT", code: "DTM_VALIDATION_ERROR" });
    const posts = dtm.posts;
    const missing = await rejection(
      connector().execute(request({ payload: { referral_id: randomUUID() } })),
    );
    expect(missing).toBeInstanceOf(PermanentConnectorError);
    expect(missing).toMatchObject({ code: "REFERRAL_DELIVERY_INCOMPLETE" });
    expect(dtm.posts).toBe(posts);
    expect(dtm.stored.size).toBe(0);
  });

  it("a gateway's 503 or 429 is retried: the request never reached DTM", async () => {
    dtm.failNext("gateway-503", "gateway-429");
    expect(await connector().execute(request())).toMatchObject({
      status: "RETRYABLE",
      code: "DTM_HTTP_503",
    });
    expect(await connector().execute(request())).toMatchObject({
      status: "RETRYABLE",
      code: "DTM_HTTP_429",
    });
    expect(dtm.stored.size).toBe(0);
  });

  it("an unreachable DTM is safe to retry: nothing was sent", async () => {
    const closed = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const { port } = s.address() as { port: number };
        s.close(() => resolve(port));
      });
    });
    const error = await rejection(
      connector({ baseUrl: `http://127.0.0.1:${closed}` }).execute(request()),
    );
    expect(error).toBeInstanceOf(SafeRetryableConnectorError);
    expect(error).toMatchObject({ code: "DTM_UNREACHABLE" });
  });
});

describe("DTM connector: unclear outcomes are read back, never re-sent", () => {
  it.each([
    ["store-then-500", "DTM_HTTP_500"],
    ["store-then-malformed", "DTM_INVALID_RECEIPT"],
    ["store-then-huge", "DTM_INVALID_RECEIPT"],
  ] as const)(
    "%s: ambiguous, and read-back finds the single stored delivery",
    async (fault, unknown) => {
      dtm.failNext(fault);
      const r = request();
      const c = connector();
      expect(await c.execute(r)).toMatchObject({
        status: "AMBIGUOUS",
        unknown,
      });
      expect(await c.reconcile(r)).toEqual({
        schema_version: "connector-result.v1",
        execution_id: r.execution_id,
        status: "SUCCEEDED",
        external_id: "IN-000001",
      });
      expect(dtm.stored.size).toBe(1);
    },
  );

  it.each([
    ["store-then-hang", "DTM_TIMEOUT"],
    ["store-then-reset", "DTM_CONNECTION_LOST"],
  ] as const)(
    "%s: the connector throws ambiguous; read-back finds the delivery",
    async (fault, code) => {
      dtm.failNext(fault);
      const r = request();
      const c = connector();
      const error = await rejection(c.execute(r));
      expect(error).toBeInstanceOf(AmbiguousConnectorError);
      expect(error).toMatchObject({ code });
      expect(await c.reconcile(r)).toMatchObject({
        status: "SUCCEEDED",
        external_id: "IN-000001",
      });
    },
  );

  it("a 500 before storing stays unresolved: DTM's 404 is not proof while a send may still land", async () => {
    dtm.failNext("error-500");
    const r = request();
    const c = connector();
    expect(await c.execute(r)).toMatchObject({
      status: "AMBIGUOUS",
      unknown: "DTM_HTTP_500",
    });
    expect(await c.reconcile(r)).toMatchObject({
      status: "AMBIGUOUS",
      unknown: "DTM_NOT_STORED",
    });
    expect(dtm.stored.size).toBe(0);
  });

  it("a conflicting replay is ambiguous; read-back settles it from what DTM holds", async () => {
    const r = request();
    const c = connector();
    await c.execute(r);
    const changed = { ...delivery, reason: "Changed after sending" };
    const replay = { ...r, payload: { ...r.payload, delivery: changed } };
    expect(await c.execute(replay)).toMatchObject({
      status: "AMBIGUOUS",
      unknown: "DTM_IDEMPOTENCY_CONFLICT",
    });
    expect(await c.reconcile(replay)).toMatchObject({
      status: "SUCCEEDED",
      external_id: "IN-000001",
    });
    expect(dtm.stored.size).toBe(1);
  });

  it("read-back failures are inconclusive, never a verdict", async () => {
    const r = request();
    await connector().execute(r);
    expect(
      await connector({
        secret: "another-secret-0123456789abcdefghij",
      }).reconcile(r),
    ).toMatchObject({ status: "AMBIGUOUS", unknown: "DTM_READBACK_HTTP_401" });
    expect(
      await connector({ baseUrl: "http://127.0.0.1:9" }).reconcile(r),
    ).toMatchObject({ status: "AMBIGUOUS" });
  });
});

describe("DTM connector: status and capabilities", () => {
  it("reads inbox status by reference: received, accepted, closed, not found", async () => {
    const c = connector();
    await c.execute(request());
    const status = async (ref: string) =>
      (await c.getReferralStatus({ destination_reference: ref })).status;
    expect(await status("IN-000001")).toBe("RECEIVED");
    dtm.resolve("IN-000001", "accepted");
    expect(await status("IN-000001")).toBe("ACCEPTED");
    dtm.resolve("IN-000001", "declined");
    expect(await status("IN-000001")).toBe("CLOSED");
    expect(await status("IN-999999")).toBe("NOT_FOUND");
    // Not a DTM reference: never sent.
    const gets = dtm.gets;
    expect(await status("MOCK-1234")).toBe("UNKNOWN");
    expect(dtm.gets).toBe(gets);
  });

  it("declares delivery and read-back only; booking stays manual", async () => {
    const c = connector();
    expect(c.capabilities()).toEqual([
      {
        capability: "referral.create",
        idempotentByExecutionId: true,
        sendsReferralContent: true,
      },
      { capability: "referral.status.read", idempotentByExecutionId: true },
    ]);
    expect(
      new CapabilityGate(c, ["referral.create", "appointment.create"]).list(),
    ).toEqual(["referral.create"]);
    expect(
      await c.execute(request({ operation: "appointment.create" })),
    ).toMatchObject({
      status: "UNSUPPORTED_OPERATION",
      capability: "appointment.create",
    });
    await expect(c.getAppointmentOutcome()).rejects.toBeInstanceOf(
      UnsupportedOperationError,
    );
  });
});
