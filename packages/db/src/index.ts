import pg from "pg";
import { createHash } from "node:crypto";
import type { Command } from "@access/contracts";
import { transition, type ReferralState } from "@access/domain";
const runtimeKind =
  process.env.ACCESS_RUNTIME_KIND ??
  (process.env.WORKER_DATABASE_URL && !process.env.API_DATABASE_URL
    ? "worker"
    : "api");
const databaseUrl =
  runtimeKind === "worker"
    ? process.env.WORKER_DATABASE_URL
    : process.env.API_DATABASE_URL;
if (
  !databaseUrl &&
  ["staging", "production"].includes(process.env.NODE_ENV ?? "")
)
  throw new Error(
    `${runtimeKind === "worker" ? "WORKER" : "API"}_DATABASE_URL required`,
  );
export const pool = new pg.Pool({
  connectionString: databaseUrl ?? process.env.DATABASE_URL,
  ssl:
    process.env.DATABASE_SSL === "require"
      ? { rejectUnauthorized: true }
      : undefined,
});
export type DbClient = pg.PoolClient;
export async function verifyRuntimeIdentity(
  db: pg.Pool,
  expected: "access_request" | "access_worker",
): Promise<void> {
  const result = await db.query<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT current_user,r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user`,
  );
  const identity = result.rows[0];
  if (
    !identity ||
    identity.current_user !== expected ||
    identity.rolsuper ||
    identity.rolbypassrls
  )
    throw new Error(`unsafe database identity; expected ${expected}`);
  const owns = await db.query(
    `SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.relname IN ('referrals','outbox','evidence_events') AND r.rolname=current_user LIMIT 1`,
  );
  if (owns.rowCount)
    throw new Error("runtime database identity owns application tables");
}
export async function tenantTx<T>(
  tenantId: string,
  fn: (c: DbClient) => Promise<T>,
  db: pg.Pool = pool,
): Promise<T> {
  if (!tenantId) throw new Error("tenant context required");
  const c = await db.connect();
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

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(object[k])}`)
    .join(",")}}`;
}
export interface EvidenceInput {
  tenantId: string;
  referralId: string;
  aggregateVersion: number;
  eventType: string;
  payload: object;
  correlationId: string;
  createdAt?: Date;
}
export function evidenceHash(
  input: EvidenceInput & {
    sequence: number;
    previousHash: string;
    createdAt: Date;
  },
): string {
  return createHash("sha256")
    .update(
      stable({
        referral_id: input.referralId,
        sequence: input.sequence,
        aggregate_version: input.aggregateVersion,
        event_type: input.eventType,
        payload: input.payload,
        previous_hash: input.previousHash,
        correlation_id: input.correlationId,
        created_at: input.createdAt.toISOString(),
      }),
    )
    .digest("hex");
}
export async function appendEvidenceEvent(c: DbClient, input: EvidenceInput) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${input.tenantId}:${input.referralId}`,
  ]);
  const prior = await c.query<{ sequence: number; hash: string }>(
    "SELECT sequence,hash FROM evidence_events WHERE tenant_id=$1 AND referral_id=$2 ORDER BY sequence DESC LIMIT 1",
    [input.tenantId, input.referralId],
  );
  const sequence = (prior.rows[0]?.sequence ?? 0) + 1;
  const previousHash = prior.rows[0]?.hash ?? "GENESIS";
  const createdAt = input.createdAt ?? new Date();
  const hash = evidenceHash({ ...input, sequence, previousHash, createdAt });
  await c.query(
    `INSERT INTO evidence_events(tenant_id,referral_id,sequence,aggregate_version,event_type,payload,previous_hash,hash,correlation_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      input.tenantId,
      input.referralId,
      sequence,
      input.aggregateVersion,
      input.eventType,
      input.payload,
      previousHash,
      hash,
      input.correlationId,
      createdAt,
    ],
  );
  return { sequence, previousHash, hash };
}
export async function verifyEvidenceChain(
  c: DbClient,
  tenantId: string,
  referralId: string,
) {
  const rows = await c.query<{
    sequence: number;
    aggregate_version: number;
    event_type: string;
    payload: object;
    previous_hash: string;
    hash: string;
    correlation_id: string;
    created_at: Date;
  }>(
    "SELECT sequence,aggregate_version,event_type,payload,previous_hash,hash,correlation_id,created_at FROM evidence_events WHERE tenant_id=$1 AND referral_id=$2 ORDER BY sequence",
    [tenantId, referralId],
  );
  let previousHash = "GENESIS",
    sequence = 1;
  for (const row of rows.rows) {
    if (row.sequence !== sequence || row.previous_hash !== previousHash)
      return false;
    const expected = evidenceHash({
      tenantId,
      referralId,
      sequence,
      aggregateVersion: row.aggregate_version,
      eventType: row.event_type,
      payload: row.payload,
      correlationId: row.correlation_id,
      createdAt: new Date(row.created_at),
      previousHash,
    });
    if (row.hash !== expected) return false;
    previousHash = row.hash;
    sequence++;
  }
  return true;
}
export async function transitionReferral(
  c: DbClient,
  input: {
    tenantId: string;
    referralId: string;
    to: ReferralState;
    expectedVersion?: number;
    externalId?: string | null;
  },
) {
  const current = await c.query<{ state: ReferralState; version: number }>(
    "SELECT state,version FROM referrals WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
    [input.tenantId, input.referralId],
  );
  if (!current.rowCount)
    throw Object.assign(new Error("not found"), { statusCode: 404 });
  const row = current.rows[0]!;
  if (
    input.expectedVersion !== undefined &&
    row.version !== input.expectedVersion
  )
    throw Object.assign(new Error("version conflict"), { statusCode: 409 });
  transition(row.state, input.to);
  const updated = await c.query<{ version: number }>(
    "UPDATE referrals SET state=$1,version=version+1,external_id=coalesce($2,external_id),updated_at=now() WHERE tenant_id=$3 AND id=$4 RETURNING version",
    [input.to, input.externalId ?? null, input.tenantId, input.referralId],
  );
  return updated.rows[0]!.version;
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
  const version = await transitionReferral(c, {
    tenantId: command.tenant_id,
    referralId: command.subject.id,
    to: next.state,
    expectedVersion: command.expected_version,
  });
  await appendEvidenceEvent(c, {
    tenantId: command.tenant_id,
    referralId: command.subject.id,
    aggregateVersion: version,
    eventType: next.eventType,
    payload: next.event,
    correlationId: command.correlation_id,
  });
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
