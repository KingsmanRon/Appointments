import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "../../packages/db/src/index.js";
import { closePools, databaseEnabled, ownerPool } from "../support/harness.js";

/**
 * A database restart or failover drops every idle connection. The API and
 * the worker must survive it and reconnect, not end on an unhandled error.
 */
describe.runIf(databaseEnabled)("database connection loss", () => {
  afterAll(closePools);

  it("survives the server dropping idle connections, reports it, and reconnects", async () => {
    const lost: string[] = [];
    const pool = createPool({
      connectionString: process.env.TEST_DATABASE_URL!,
      max: 2,
      applicationName: "access-reconnect-probe",
      onIdleError: (e) => lost.push((e as { code?: string }).code ?? e.name),
    });
    try {
      const before = await pool.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      // What a restart does to an idle pooled connection.
      await ownerPool().query("SELECT pg_terminate_backend($1)", [
        before.rows[0]!.pid,
      ]);
      for (let i = 0; i < 50 && lost.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(lost).toEqual(["57P01"]);
      const after = await pool.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      expect(after.rows[0]!.pid).not.toBe(before.rows[0]!.pid);
    } finally {
      await pool.end();
    }
  });

  it("does not need a listener to survive", async () => {
    const pool = createPool({
      connectionString: process.env.TEST_DATABASE_URL!,
      max: 1,
    });
    try {
      const { rows } = await pool.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      await ownerPool().query("SELECT pg_terminate_backend($1)", [
        rows[0]!.pid,
      ]);
      await new Promise((r) => setTimeout(r, 200));
      expect((await pool.query("SELECT 1 AS ok")).rows[0]).toEqual({ ok: 1 });
    } finally {
      await pool.end();
    }
  });
});
