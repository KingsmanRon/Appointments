import pg from "pg";
import type { Command } from "@access/contracts";
import type { ReferralState } from "@access/domain";
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "require"
      ? { rejectUnauthorized: true }
      : undefined,
});
export type DbClient = pg.PoolClient;
export async function tenantTx<T>(
  tenantId: string,
  fn: (c: DbClient) => Promise<T>,
): Promise<T> {
  if (!tenantId) throw new Error("tenant context required");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
    const value = await fn(c);
    await c.query("COMMIT");
    return value;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
export async function processCommand(
  c: DbClient,
  command: Command,
  next: {
    state: ReferralState;
    eventType: string;
    event: object;
    outbox?: { executionId: string; payload: object };
  },
): Promise<{ deduplicated: boolean; version: number }> {
  const prior = await c.query<{ result_json: { version: number } }>(
    "SELECT result_json FROM commands WHERE tenant_id=$1 AND command_id=$2",
    [command.tenant_id, command.command_id],
  );
  if (prior.rowCount)
    return { deduplicated: true, version: prior.rows[0]!.result_json.version };
  const updated = await c.query<{ version: number }>(
    "UPDATE referrals SET state=$1,version=version+1,updated_at=now() WHERE tenant_id=$2 AND id=$3 AND version=$4 RETURNING version",
    [
      next.state,
      command.tenant_id,
      command.subject.id,
      command.expected_version,
    ],
  );
  if (!updated.rowCount)
    throw Object.assign(new Error("version conflict"), { statusCode: 409 });
  const version = updated.rows[0]!.version;
  const previous = await c.query<{ hash: string }>(
    `SELECT hash FROM evidence_events WHERE tenant_id=$1 AND referral_id=$2 ORDER BY sequence DESC LIMIT 1`,
    [command.tenant_id, command.subject.id],
  );
  const previousHash = previous.rows[0]?.hash ?? "GENESIS";
  const canonical = JSON.stringify({
    type: next.eventType,
    version,
    payload: next.event,
    previousHash,
  });
  const hash = (await import("node:crypto"))
    .createHash("sha256")
    .update(canonical)
    .digest("hex");
  await c.query(
    `INSERT INTO evidence_events(tenant_id,referral_id,sequence,event_type,payload,previous_hash,hash,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      command.tenant_id,
      command.subject.id,
      version,
      next.eventType,
      next.event,
      previousHash,
      hash,
      command.correlation_id,
    ],
  );
  if (next.outbox)
    await c.query(
      `INSERT INTO outbox(tenant_id,referral_id,aggregate_version,execution_id,payload,correlation_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        command.tenant_id,
        command.subject.id,
        version,
        next.outbox.executionId,
        next.outbox.payload,
        command.correlation_id,
      ],
    );
  await c.query(
    "INSERT INTO commands(tenant_id,command_id,referral_id,result_json) VALUES($1,$2,$3,$4)",
    [command.tenant_id, command.command_id, command.subject.id, { version }],
  );
  return { deduplicated: false, version };
}
