import { beforeAll, afterAll, describe, it, expect } from "vitest";
import pg from "pg";
import { readFile } from "node:fs/promises";
import {
  appendEvidenceEvent,
  tenantTx,
  transitionReferral,
  verifyEvidenceChain,
  verifyRuntimeIdentity,
} from "../../packages/db/src/index.js";
const enabled = Boolean(process.env.TEST_DATABASE_URL);
describe.runIf(enabled)("real PostgreSQL invariants", () => {
  let pool: pg.Pool;
  const a = "11111111-1111-4111-8111-111111111111",
    b = "22222222-2222-4222-8222-222222222222";
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await pool.query(
      await readFile("supabase/migrations/0001_access.sql", "utf8"),
    );
    await pool.query(
      await readFile("supabase/migrations/0002_staging_hardening.sql", "utf8"),
    );
    await pool.query(await readFile("supabase/seed.sql", "utf8"));
  });
  it("runtime logins are least privilege and use the application's tenant transaction", async () => {
    await pool.query(
      "ALTER ROLE access_request LOGIN PASSWORD 'integration-api'",
    );
    await pool.query(
      "ALTER ROLE access_worker LOGIN PASSWORD 'integration-worker'",
    );
    const base = new URL(process.env.TEST_DATABASE_URL!);
    const runtime = async (role: string, password: string) => {
      const url = new URL(base);
      url.username = role;
      url.password = password;
      return new pg.Pool({ connectionString: url.toString() });
    };
    const api = await runtime("access_request", "integration-api");
    const worker = await runtime("access_worker", "integration-worker");
    try {
      await verifyRuntimeIdentity(api, "access_request");
      await verifyRuntimeIdentity(worker, "access_worker");
      expect(
        await tenantTx(
          a,
          (c) => c.query("SELECT * FROM referrals WHERE tenant_id=$1", [b]),
          api,
        ),
      ).toHaveProperty("rowCount", 0);
      await expect(
        tenantTx(
          a,
          (c) =>
            c.query(
              "INSERT INTO referrals(id,tenant_id,state) VALUES(gen_random_uuid(),$1,'RECEIVED')",
              [b],
            ),
          api,
        ),
      ).rejects.toThrow();
      await expect(
        tenantTx(
          a,
          (c) =>
            c.query("UPDATE outbox SET status='DONE' WHERE tenant_id=$1", [a]),
          api,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        tenantTx(
          a,
          (c) =>
            c.query(
              "INSERT INTO artifacts(tenant_id,referral_id,object_key,digest_sha256,media_type,size_bytes,scan_status,encryption_key_id) VALUES($1,gen_random_uuid(),'x',repeat('a',64),'text/plain',1,'CLEAN','x')",
              [a],
            ),
          worker,
        ),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await api.end();
      await worker.end();
    }
  });
  it("canonical evidence verifies and detects payload and sequence tampering", async () => {
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [a]);
      await c.query(
        "INSERT INTO referrals(id,tenant_id,state) VALUES($1,$2,'RECEIVED') ON CONFLICT DO NOTHING",
        [id, a],
      );
      await appendEvidenceEvent(c, {
        tenantId: a,
        referralId: id,
        aggregateVersion: 0,
        eventType: "received",
        payload: { b: 2, a: 1 },
        correlationId: id,
      });
      await appendEvidenceEvent(c, {
        tenantId: a,
        referralId: id,
        aggregateVersion: 1,
        eventType: "reviewed",
        payload: { ok: true },
        correlationId: id,
      });
      expect(await verifyEvidenceChain(c, a, id)).toBe(true);
      await c.query(
        "UPDATE evidence_events SET payload='{\"ok\":false}' WHERE tenant_id=$1 AND referral_id=$2 AND sequence=2",
        [a, id],
      );
      expect(await verifyEvidenceChain(c, a, id)).toBe(false);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
  it("database transition guard rejects bypass and rolls back side effects", async () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [a]);
      await c.query(
        "INSERT INTO referrals(id,tenant_id,state) VALUES($1,$2,'COMPLETED')",
        [id, a],
      );
      await expect(
        transitionReferral(c, {
          tenantId: a,
          referralId: id,
          to: "DISPATCH_PENDING",
        }),
      ).rejects.toThrow();
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });
  it("migration is repeatable and recorded", async () => {
    await pool.query(
      await readFile("supabase/migrations/0001_access.sql", "utf8"),
    );
    await pool.query(
      await readFile("supabase/migrations/0002_staging_hardening.sql", "utf8"),
    );
    expect(
      (
        await pool.query(
          "SELECT version FROM schema_migrations WHERE version='0001_access'",
        )
      ).rowCount,
    ).toBe(1);
  });
  it("atomically rolls back state, evidence and outbox at a forced crash boundary", async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "INSERT INTO referrals(id,tenant_id,state) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,'RECEIVED')",
        [a],
      );
      await c.query(
        "INSERT INTO evidence_events(tenant_id,referral_id,sequence,aggregate_version,event_type,payload,previous_hash,hash,correlation_id) VALUES($1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,1,'test','{}','GENESIS','hash','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')",
        [a],
      );
      await c.query(
        "INSERT INTO outbox(tenant_id,referral_id,aggregate_version,execution_id,payload,correlation_id) VALUES($1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')",
        [a],
      );
      await c.query("ROLLBACK");
      for (const [table, column] of [
        ["referrals", "id"],
        ["evidence_events", "referral_id"],
        ["outbox", "referral_id"],
      ])
        expect(
          (
            await c.query(
              `SELECT count(*)::int n FROM ${table} WHERE ${column}='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
            )
          ).rows[0].n,
        ).toBe(0);
    } finally {
      // Never return an aborted transaction to the shared pool: a failed
      // assertion or schema regression must not cascade into later tests.
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  });
  it("RLS fails closed and isolates every tenant table", async () => {
    const tables = [
      "referrals",
      "artifacts",
      "commands",
      "evidence_events",
      "work_items",
      "executions",
      "outbox",
    ];
    const c = await pool.connect();
    try {
      await c.query(
        "INSERT INTO referrals(id,tenant_id,state) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,'RECEIVED'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$2,'RECEIVED') ON CONFLICT DO NOTHING",
        [a, b],
      );
      await c.query("SET ROLE access_request");
      for (const table of tables) {
        await c.query("RESET app.tenant_id");
        expect(
          (await c.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n,
        ).toBe(0);
        await c.query("SELECT set_config('app.tenant_id',$1,false)", [b]);
        expect(
          (
            await c.query(
              `SELECT count(*)::int n FROM ${table} WHERE tenant_id=$1`,
              [a],
            )
          ).rows[0].n,
        ).toBe(0);
      }
      expect(
        (
          await c.query(
            "SELECT count(*)::int n FROM referrals WHERE tenant_id=$1",
            [b],
          )
        ).rows[0].n,
      ).toBe(1);
    } finally {
      try {
        await c.query("ROLLBACK");
        await c.query("RESET ROLE");
      } finally {
        c.release();
      }
    }
  });
  afterAll(async () => {
    await pool.end();
  });
});
