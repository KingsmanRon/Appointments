import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ConnectorRequest } from "../../packages/contracts/src/index.js";
import { DtmConnector } from "../../apps/worker/src/dtm-connector.js";
import { FakeDtm } from "../support/fake-dtm.js";
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
  testApi,
  type TestApi,
} from "../support/harness.js";

const DTM_CAPABILITIES = ["referral.create", "referral.status.read"];

async function execution(caseId: string) {
  return (
    await ownerPool().query(
      "SELECT id,status,attempts,reconcile_attempts,external_id,last_error,escalated_at FROM executions WHERE case_id=$1 ORDER BY created_at",
      [caseId],
    )
  ).rows;
}
async function referral(caseId: string) {
  return (
    await ownerPool().query(
      "SELECT destination_reference,destination_reference_source FROM referrals WHERE case_id=$1",
      [caseId],
    )
  ).rows[0];
}
async function openWork(caseId: string) {
  return (
    await ownerPool().query(
      "SELECT id,kind,reason FROM work_items WHERE case_id=$1 AND status='OPEN' ORDER BY created_at",
      [caseId],
    )
  ).rows;
}

describe.runIf(databaseEnabled)(
  "DTM connector through the dispatcher (real PostgreSQL, fake DTM)",
  () => {
    let t: TestApi;
    const fakes: FakeDtm[] = [];
    /** A tenant with one ready referral, and a DTM that accepts its tenant. */
    async function setup(dataMode: "SYNTHETIC" | "REAL" = "SYNTHETIC") {
      const tenant = await newTenant();
      const dtm = await FakeDtm.start({ tenantId: tenant, dataMode });
      fakes.push(dtm);
      const r = await ingest(t, tenant);
      const connector = new DtmConnector({
        baseUrl: dtm.baseUrl,
        keyId: dtm.options.keyId,
        secret: dtm.options.secret,
        timeoutMs: 1_000,
        dataMode: "SYNTHETIC",
      });
      const d = dispatcher([tenant], connector, {
        capabilities: DTM_CAPABILITIES,
        maxReconcile: 3,
      });
      return { tenant, dtm, r, d };
    }
    beforeAll(async () => {
      t = await testApi();
    });
    afterEach(async () => {
      await Promise.all(fakes.splice(0).map((f) => f.close()));
    });
    afterAll(async () => {
      await t.close();
      await closePools();
    });

    it("delivers a ready referral to DTM's inbox: one stored delivery, READY_FOR_BOOKING, no patient details persisted", async () => {
      const { dtm, r, d } = await setup();
      expect(r.state).toBe("DESTINATION_PENDING");
      await drain(d);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      expect(await referral(r.case_id)).toEqual({
        destination_reference: "IN-000001",
        destination_reference_source: "CONNECTOR",
      });
      expect(await execution(r.case_id)).toMatchObject([
        { id: r.execution_id, status: "SUCCEEDED", external_id: "IN-000001" },
      ]);
      expect(dtm.posts).toBe(1);
      expect(dtm.stored.size).toBe(1);
      expect(dtm.lastBody).toMatchObject({
        execution_id: r.execution_id,
        data_mode: "SYNTHETIC",
        referral: {
          case_reference: `REF-${r.case_id.replace(/-/g, "").slice(0, 8).toUpperCase()}`,
          referral_id: r.referral_id,
          patient: {
            given_name: "Synthetic",
            family_name: "Patient",
            date_of_birth: "1980-01-01",
            identifier: "SYN-001",
          },
          referrer: { name: "Dr Fixture" },
          documents_held: ["demographics", "insurance", "referral_letter"],
        },
      });
      // The delivery lived only in memory: nothing about the patient was
      // added to the outbox, executions or evidence.
      const stored = await ownerPool().query(
        `SELECT (SELECT json_agg(payload)::text FROM outbox WHERE case_id=$1) AS outbox,
                (SELECT json_agg(e)::text FROM executions e WHERE case_id=$1) AS executions,
                (SELECT json_agg(payload)::text FROM evidence_events WHERE case_id=$1) AS evidence`,
        [r.case_id],
      );
      for (const text of Object.values(stored.rows[0]) as string[]) {
        expect(text).not.toContain("Synthetic");
        expect(text).not.toContain("SYN-001");
        expect(text).not.toContain('"delivery"');
      }
    });

    it("timeout after DTM stored it: ambiguous, read back by execution id, committed; never re-sent", async () => {
      const { dtm, r, d } = await setup();
      dtm.failNext("store-then-hang");
      await d.tick();
      expect(await execution(r.case_id)).toMatchObject([
        { status: "AMBIGUOUS", last_error: "DTM_TIMEOUT" },
      ]);
      expect((await caseState(r.case_id)).current_state).toBe(
        "DESTINATION_PENDING",
      );
      await drain(d);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      expect((await referral(r.case_id)).destination_reference).toBe(
        "IN-000001",
      );
      expect(dtm.posts).toBe(1);
      expect(dtm.stored.size).toBe(1);
    });

    it("500 before DTM stored it: read-back never confirms, a person decides; a retry after attestation delivers once", async () => {
      const { tenant, dtm, r, d } = await setup();
      dtm.failNext("error-500");
      await drain(d);
      const [e] = await execution(r.case_id);
      expect(e).toMatchObject({
        status: "AMBIGUOUS",
        reconcile_attempts: 3,
        last_error: "READBACK_INCONCLUSIVE",
      });
      expect(e.escalated_at).not.toBeNull();
      expect((await caseState(r.case_id)).current_state).toBe("EXCEPTION");
      const [work] = await openWork(r.case_id);
      expect(work).toMatchObject({
        kind: "CONNECTOR",
        reason: "reconciliation_escalated:RECONCILIATION_EXHAUSTED",
      });
      expect(dtm.posts).toBe(1);
      expect(dtm.stored.size).toBe(0);
      // Reception confirmed DTM's inbox has nothing: staff retry, attested.
      const retried = await t.app.inject({
        method: "POST",
        url: `/v1/cases/${r.case_id}/actions`,
        headers: { "x-tenant-id": tenant },
        payload: {
          action: "resolve_exception",
          command_id: randomUUID(),
          correlation_id: randomUUID(),
          expected_version: (await caseState(r.case_id)).version,
          note: "DTM inbox checked, not there",
          work_item_id: work.id,
          resolution: "retry_destination",
          attest_not_committed: true,
        },
      });
      expect(retried.statusCode, retried.body).toBe(200);
      await drain(d);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      expect((await execution(r.case_id)).map((x) => x.status)).toEqual([
        "AMBIGUOUS",
        "SUCCEEDED",
      ]);
      expect(dtm.posts).toBe(2);
      expect(dtm.stored.size).toBe(1);
    });

    it("a gateway's 503 is retried with the same execution and stored once", async () => {
      const { dtm, r, d } = await setup();
      dtm.failNext("gateway-503");
      await drain(d);
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      expect(await execution(r.case_id)).toMatchObject([
        { id: r.execution_id, status: "SUCCEEDED", attempts: 2 },
      ]);
      expect(dtm.posts).toBe(2);
      expect(dtm.stored.size).toBe(1);
    });

    it("DTM refusing test data (wrong data mode) opens a connector exception; nothing stored", async () => {
      const { dtm, r, d } = await setup("REAL");
      await drain(d);
      expect((await caseState(r.case_id)).current_state).toBe("EXCEPTION");
      expect(await openWork(r.case_id)).toMatchObject([
        {
          kind: "CONNECTOR",
          reason: "destination_failed:DTM_DATA_MODE_MISMATCH",
        },
      ]);
      expect(dtm.posts).toBe(1);
      expect(dtm.stored.size).toBe(0);
    });

    it("a referral whose facts no longer make a complete delivery is entered by hand; nothing is sent", async () => {
      const { dtm, r, d } = await setup();
      await ownerPool().query(
        `UPDATE referrals SET extraction=jsonb_set(extraction,'{patient,given_name}','" "') WHERE case_id=$1`,
        [r.case_id],
      );
      await drain(d);
      expect((await caseState(r.case_id)).current_state).toBe("EXCEPTION");
      expect(await openWork(r.case_id)).toMatchObject([
        {
          kind: "MANUAL_DESTINATION",
          reason: "destination_failed:REFERRAL_DELIVERY_INCOMPLETE",
        },
      ]);
      expect(dtm.posts).toBe(0);
    });

    it("connectors that do not send referral content never receive patient details", async () => {
      const tenant = await newTenant();
      const r = await ingest(t, tenant);
      const connector = mock();
      const seen: ConnectorRequest[] = [];
      const execute = connector.execute.bind(connector);
      connector.execute = async (request) => {
        seen.push(request);
        return execute(request);
      };
      await drain(dispatcher([tenant], connector));
      expect((await caseState(r.case_id)).current_state).toBe(
        "READY_FOR_BOOKING",
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]!.payload).not.toHaveProperty("delivery");
      expect(JSON.stringify(seen[0])).not.toContain("Synthetic");
    });
  },
);
