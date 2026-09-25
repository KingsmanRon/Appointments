import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MIGRATIONS_DIRECTORY,
  appendEvidence,
  legacyEvidenceHash,
  migrate,
  verifyEvidenceChain,
} from "../../packages/db/src/index.js";
import { databaseEnabled } from "../support/harness.js";

/** TS mirror of access_derived_uuid() in 0003. */
function derivedUuid(namespace: string, a: string, b: string): string {
  const h = createHash("md5").update(`${namespace}:${a}:${b}`).digest("hex");
  const variant = "89ab"[parseInt(h[16]!, 16) % 4];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const created: string[] = [];
async function scratchDatabase(): Promise<pg.Pool> {
  const name = `access_mig_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const admin = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
  });
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  created.push(name);
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  return new pg.Pool({ connectionString: url.toString(), max: 4 });
}
async function migrationsCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "access-migrations-"));
  await cp(DEFAULT_MIGRATIONS_DIRECTORY, dir, { recursive: true });
  return dir;
}

describe.runIf(databaseEnabled)("ledger migrations and legacy backfill", () => {
  afterAll(async () => {
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
    });
    for (const name of created)
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("applies once, records checksums and is a no-op when re-run (never re-executes)", async () => {
    const pool = await scratchDatabase();
    try {
      const first = await migrate(pool);
      expect(first.applied).toHaveLength(5);
      const second = await migrate(pool);
      expect(second).toEqual({
        applied: [],
        baselined: [],
        alreadyApplied: first.applied,
      });
      const ledger = await pool.query(
        "SELECT version,checksum FROM schema_migrations ORDER BY version",
      );
      expect(ledger.rows.map((r) => r.version)).toEqual(first.applied);
      for (const r of ledger.rows) expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await pool.end();
    }
  });

  it("concurrent migrators serialise on the advisory lock", async () => {
    const pool = await scratchDatabase();
    try {
      const [a, b] = await Promise.all([migrate(pool), migrate(pool)]);
      expect([...a.applied, ...b.applied].sort()).toHaveLength(5);
    } finally {
      await pool.end();
    }
  });

  it("detects mutation of an already-applied migration", async () => {
    const pool = await scratchDatabase();
    const dir = await migrationsCopy();
    try {
      await migrate(pool, { directory: dir });
      const file = join(dir, "0004_interactions_outcomes_rules.sql");
      await writeFile(
        file,
        `${await readFile(file, "utf8")}\n-- edited after deployment\n`,
      );
      await expect(migrate(pool, { directory: dir })).rejects.toThrow(
        /0004_interactions_outcomes_rules was modified/,
      );
    } finally {
      await pool.end();
    }
  });

  it("never records a failed migration and applies it once fixed", async () => {
    const pool = await scratchDatabase();
    const dir = await mkdtemp(join(tmpdir(), "access-migrations-bad-"));
    try {
      await writeFile(
        join(dir, "0001_ok.sql"),
        "CREATE TABLE probe_one(id int);",
      );
      await writeFile(
        join(dir, "0002_bad.sql"),
        "CREATE TABLE probe_two(id int);\nSELECT * FROM missing_table;",
      );
      await expect(migrate(pool, { directory: dir })).rejects.toThrow(
        /0002_bad failed and was rolled back/,
      );
      expect(
        (await pool.query("SELECT version FROM schema_migrations")).rows.map(
          (r) => r.version,
        ),
      ).toEqual(["0001_ok"]);
      expect(
        (await pool.query("SELECT to_regclass('probe_two') AS t")).rows[0].t,
      ).toBeNull();
      await writeFile(
        join(dir, "0002_bad.sql"),
        "CREATE TABLE probe_two(id int);",
      );
      expect((await migrate(pool, { directory: dir })).applied).toEqual([
        "0002_bad",
      ]);
      await writeFile(join(dir, "0001_late.sql"), "SELECT 1;");
      await expect(migrate(pool, { directory: dir })).rejects.toThrow(
        /duplicate migration number 0001/,
      );
    } finally {
      await pool.end();
    }
  });

  it("refuses out-of-order and missing migrations", async () => {
    const pool = await scratchDatabase();
    const dir = await mkdtemp(join(tmpdir(), "access-migrations-order-"));
    try {
      await writeFile(join(dir, "0001_a.sql"), "SELECT 1;");
      await writeFile(join(dir, "0003_c.sql"), "SELECT 1;");
      await migrate(pool, { directory: dir });
      await writeFile(join(dir, "0002_b.sql"), "SELECT 1;");
      await expect(migrate(pool, { directory: dir })).rejects.toThrow(
        /out-of-order/,
      );
      const other = await mkdtemp(join(tmpdir(), "access-migrations-missing-"));
      await writeFile(join(other, "0001_a.sql"), "SELECT 1;");
      await expect(migrate(pool, { directory: other })).rejects.toThrow(
        /missing from the migrations directory/,
      );
    } finally {
      await pool.end();
    }
  });

  it("baselines migrations recorded by the pre-ledger runner", async () => {
    const pool = await scratchDatabase();
    try {
      // The v1 runner simply executed each file; they recorded themselves.
      for (const f of ["0001_access.sql", "0002_staging_hardening.sql"])
        await pool.query(
          await readFile(join(DEFAULT_MIGRATIONS_DIRECTORY, f), "utf8"),
        );
      const result = await migrate(pool);
      expect(result.baselined).toEqual([
        "0001_access",
        "0002_staging_hardening",
      ]);
      expect(result.applied).toEqual([
        "0003_access_cases",
        "0004_interactions_outcomes_rules",
        "0005_workforce_identity_and_privileges",
      ]);
    } finally {
      await pool.end();
    }
  });

  it("backfills legacy referrals deterministically into cases with a continuous evidence chain", async () => {
    const pool = await scratchDatabase();
    try {
      await migrate(pool, { until: "0002_staging_hardening" });
      const tenant = randomUUID();
      await pool.query(
        "INSERT INTO organisations(id,name) VALUES($1,'Legacy org')",
        [tenant],
      );
      const states = [
        "RECEIVED",
        "IDENTITY_PENDING",
        "ADMIN_PENDING",
        "DISPATCH_PENDING",
        "RECONCILING",
        "COMPLETED",
        "EXCEPTION",
        "REJECTED",
      ];
      const referrals: Record<string, string> = {};
      for (const state of states) {
        const id = randomUUID();
        referrals[state] = id;
        await pool.query(
          "INSERT INTO referrals(id,tenant_id,state,version,identity_status,extraction,external_id) VALUES($1,$2,$3,$4,'RESOLVED',$5,$6)",
          [
            id,
            tenant,
            state,
            3,
            { referrer: { name: "Dr Legacy" }, documents: [] },
            state === "COMPLETED" ? "MOCK-LEGACY" : null,
          ],
        );
      }
      const completed = referrals.COMPLETED!;
      // A v1 evidence chain written by the legacy code.
      let previous = "GENESIS";
      for (let sequence = 1; sequence <= 3; sequence++) {
        const createdAt = new Date(Date.UTC(2026, 0, 1, 0, sequence));
        const payload = { step: sequence, nested: { b: 2, a: 1 } };
        const hash = legacyEvidenceHash({
          referralId: completed,
          sequence,
          aggregateVersion: sequence,
          eventType: `legacy_${sequence}`,
          payload,
          previousHash: previous,
          correlationId: completed,
          createdAt,
        });
        await pool.query(
          "INSERT INTO evidence_events(tenant_id,referral_id,sequence,aggregate_version,event_type,payload,previous_hash,hash,correlation_id,created_at) VALUES($1,$2,$3,$3,$4,$5,$6,$7,$2,$8)",
          [
            tenant,
            completed,
            sequence,
            `legacy_${sequence}`,
            payload,
            previous,
            hash,
            createdAt,
          ],
        );
        previous = hash;
      }
      const execution = randomUUID();
      await pool.query(
        "INSERT INTO outbox(tenant_id,referral_id,aggregate_version,execution_id,payload,correlation_id,status) VALUES($1,$2,3,$3,$4,$2,'DONE')",
        [
          tenant,
          referrals.RECONCILING,
          execution,
          {
            schema_version: "referral-create.v1",
            execution_id: execution,
            referral_id: referrals.RECONCILING,
          },
        ],
      );
      await pool.query(
        "INSERT INTO executions(id,tenant_id,referral_id,status,attempts) VALUES($1,$2,$3,'AMBIGUOUS',1)",
        [execution, tenant, referrals.RECONCILING],
      );
      await pool.query(
        "INSERT INTO executions(id,tenant_id,referral_id,status,attempts) VALUES($1,$2,$3,'DEFERRED',1)",
        [randomUUID(), tenant, referrals.EXCEPTION],
      );
      for (let i = 0; i < 3; i++)
        await pool.query(
          "INSERT INTO work_items(tenant_id,referral_id,kind,status,reason) VALUES($1,$2,'SAFETY','OPEN','urgent_or_clinical_content')",
          [tenant, referrals.EXCEPTION],
        );
      await pool.query(
        "INSERT INTO artifacts(tenant_id,referral_id,object_key,digest_sha256,media_type,size_bytes,scan_status,encryption_key_id) VALUES($1,$2,'legacy/key.enc',repeat('a',64),'text/plain',1,'CLEAN','local-aes-v1')",
        [tenant, completed],
      );
      await pool.query(
        "INSERT INTO commands(tenant_id,command_id,referral_id,result_json) VALUES($1,$2,$3,'{\"version\":3}')",
        [tenant, randomUUID(), completed],
      );

      const result = await migrate(pool);
      expect(result.applied).toHaveLength(3);
      const cases = await pool.query(
        "SELECT id,current_state,version,legacy_referral_state,resolution_code FROM access_cases WHERE tenant_id=$1",
        [tenant],
      );
      expect(cases.rowCount).toBe(states.length);
      const expected: Record<string, string> = {
        RECEIVED: "RECEIVED",
        IDENTITY_PENDING: "IDENTITY_PENDING",
        ADMIN_PENDING: "INFORMATION_MISSING",
        DISPATCH_PENDING: "DESTINATION_PENDING",
        RECONCILING: "DESTINATION_PENDING",
        COMPLETED: "READY_FOR_BOOKING",
        EXCEPTION: "EXCEPTION",
        REJECTED: "REJECTED",
      };
      for (const [legacy, id] of Object.entries(referrals)) {
        const caseId = derivedUuid("access-case", tenant, id);
        const row = cases.rows.find((c) => c.id === caseId);
        expect(row).toMatchObject({
          current_state: expected[legacy],
          version: 3,
          legacy_referral_state: legacy,
        });
        const ref = await pool.query(
          "SELECT case_id FROM referrals WHERE id=$1",
          [id],
        );
        expect(ref.rows[0].case_id).toBe(caseId);
      }
      expect(
        cases.rows.find((c) => c.legacy_referral_state === "REJECTED")
          .resolution_code,
      ).toBe("UNKNOWN");
      for (const table of [
        "commands",
        "evidence_events",
        "work_items",
        "executions",
        "outbox",
        "artifacts",
      ]) {
        const nulls = await pool.query(
          `SELECT count(*)::int n FROM ${table} WHERE case_id IS NULL`,
        );
        expect(nulls.rows[0].n).toBe(0);
      }
      expect(
        (
          await pool.query(
            "SELECT count(*)::int n FROM work_items WHERE status='OPEN' AND kind='SAFETY'",
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (
          await pool.query(
            "SELECT status FROM executions WHERE referral_id=$1",
            [referrals.EXCEPTION],
          )
        ).rows[0].status,
      ).toBe("PERMANENT");
      expect(
        (
          await pool.query(
            "SELECT destination_reference,destination_reference_source FROM referrals WHERE id=$1",
            [completed],
          )
        ).rows[0],
      ).toEqual({
        destination_reference: "MOCK-LEGACY",
        destination_reference_source: "CONNECTOR",
      });
      // Legacy v1 links still verify, and v2 events chain onto them.
      const c = await pool.connect();
      try {
        const caseId = derivedUuid("access-case", tenant, completed);
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
        expect(await verifyEvidenceChain(c, tenant, caseId)).toMatchObject({
          valid: true,
          events: 3,
        });
        await appendEvidence(c, {
          tenantId: tenant,
          caseId,
          subject: { type: "referral", id: completed },
          aggregateVersion: 4,
          eventType: "post_migration",
          payload: { ok: true },
          correlationId: caseId,
          actor: { type: "SYSTEM", id: "test" },
        });
        expect(await verifyEvidenceChain(c, tenant, caseId)).toMatchObject({
          valid: true,
          events: 4,
        });
        await c.query("COMMIT");
      } finally {
        c.release();
      }
      const observations = await pool.query(
        "SELECT observation_type,verification_level FROM access_case_observations WHERE tenant_id=$1 ORDER BY 1",
        [tenant],
      );
      expect(
        observations.rows.filter(
          (o) => o.observation_type === "REFERRAL_RECEIVED",
        ),
      ).toHaveLength(states.length);
      expect(
        observations.rows.every((o) => o.verification_level === "DERIVED"),
      ).toBe(true);
      expect((await migrate(pool)).applied).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
