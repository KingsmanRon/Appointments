import { beforeAll, afterAll, describe, it, expect } from "vitest";
import pg from "pg";
import { readFile } from "node:fs/promises";
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
    await pool.query(await readFile("supabase/seed.sql", "utf8"));
  });
  afterAll(() => pool.end());
  it("migration is repeatable and recorded", async () => {
    await pool.query(
      await readFile("supabase/migrations/0001_access.sql", "utf8"),
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
        "INSERT INTO evidence_events(tenant_id,referral_id,sequence,event_type,payload,previous_hash,hash,correlation_id) VALUES($1,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',1,'test','{}','GENESIS','hash','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')",
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
      await c.query("RESET ROLE");
      c.release();
    }
  });
});
