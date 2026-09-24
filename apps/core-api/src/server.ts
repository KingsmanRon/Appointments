import Fastify from "fastify";
import cors from "@fastify/cors";
import { ingestRequestSchema, resolutionSchema } from "@access/contracts";
import { pool, tenantTx, verifyRuntimeIdentity } from "@access/db";
import { log, Metrics } from "@access/observability";
import { EncryptedFileStore } from "./artifact.js";
import { FixtureExtractor } from "./extraction.js";
import { ReferralService } from "./service.js";
const required = ["ARTIFACT_ENCRYPTION_KEY"] as const;
for (const key of required)
  if (!process.env[key]) throw new Error(`${key} required`);
const metrics = new Metrics();
const service = new ReferralService(
  pool,
  new EncryptedFileStore(
    process.env.ARTIFACT_ROOT ?? "./data/artifacts",
    Buffer.from(process.env.ARTIFACT_ENCRYPTION_KEY!, "hex"),
  ),
  new FixtureExtractor(),
);
if (["staging", "production"].includes(process.env.NODE_ENV ?? ""))
  await verifyRuntimeIdentity(pool, "access_request");
function tenantContext(header: unknown, claimed?: string) {
  if (
    process.env.ALLOW_SYNTHETIC_TENANT_CONTEXT !== "true" &&
    process.env.NODE_ENV !== "development" &&
    process.env.NODE_ENV !== "test"
  )
    throw Object.assign(new Error("verified workforce identity required"), {
      statusCode: 401,
    });
  const tenant = String(header ?? claimed ?? "");
  if (!tenant || (claimed && tenant !== claimed))
    throw Object.assign(new Error("tenant context required"), {
      statusCode: 400,
    });
  return tenant;
}
export const app = Fastify({ logger: false, bodyLimit: 14_000_000 });
await app.register(cors, {
  origin: (process.env.CONSOLE_ORIGIN ?? "http://localhost:3000").split(","),
  methods: ["GET", "POST"],
});
app.addHook("onRequest", async (req) => {
  (req as typeof req & { start: number }).start = Date.now();
});
app.addHook("onResponse", async (req, reply) =>
  log("info", "http_request", {
    method: req.method,
    path: req.url,
    status: reply.statusCode,
    correlation_id: req.headers["x-correlation-id"],
    duration_ms: Date.now() - (req as typeof req & { start: number }).start,
  }),
);
app.get("/health", async () => ({
  status: "ok",
  build: process.env.BUILD_ID ?? "dev",
  contracts: "v1",
}));
app.get("/ready", async (_q, r) => {
  try {
    await pool.query("SELECT 1");
    return { status: "ready" };
  } catch {
    r.code(503);
    return { status: "not_ready" };
  }
});
app.get("/metrics", async () => metrics.snapshot());
app.post("/v1/referrals", async (req, reply) => {
  const input = ingestRequestSchema.parse(req.body);
  tenantContext(req.headers["x-tenant-id"], input.tenant_id);
  metrics.inc("referrals_ingested_total");
  return reply.code(201).send(await service.ingest(input));
});
app.post("/v1/referrals/:id/resolve", async (req) => {
  const tenant = tenantContext(req.headers["x-tenant-id"]);
  const params = req.params as { id: string };
  return service.resolve(tenant, params.id, resolutionSchema.parse(req.body));
});
app.get("/v1/referrals/:id", async (req) => {
  const tenant = tenantContext(req.headers["x-tenant-id"]);
  const { id } = req.params as { id: string };
  return tenantTx(tenant, async (c) => {
    const referral = await c.query(
      "SELECT id,state,version,identity_status,policy_decision,external_id,created_at,updated_at FROM referrals WHERE tenant_id=$1 AND id=$2",
      [tenant, id],
    );
    if (!referral.rowCount)
      throw Object.assign(new Error("not found"), { statusCode: 404 });
    const events = await c.query(
      "SELECT sequence,event_type,payload,hash,correlation_id,created_at FROM evidence_events WHERE tenant_id=$1 AND referral_id=$2 ORDER BY sequence",
      [tenant, id],
    );
    const work = await c.query(
      "SELECT id,kind,status,reason,evidence,resolution FROM work_items WHERE tenant_id=$1 AND referral_id=$2 ORDER BY created_at",
      [tenant, id],
    );
    const executions = await c.query(
      "SELECT id,status,attempts,external_id,last_error,updated_at FROM executions WHERE tenant_id=$1 AND referral_id=$2",
      [tenant, id],
    );
    return {
      referral: referral.rows[0],
      events: events.rows,
      work_items: work.rows,
      executions: executions.rows,
    };
  });
});
app.setErrorHandler((e, _q, r) => {
  const error = e instanceof Error ? e : new Error(String(e));
  log("error", "request_failed", { error: error.message });
  r.code((e as { statusCode?: number }).statusCode ?? 400).send({
    error: error.name,
    message: error.message,
  });
});
if (process.env.NODE_ENV !== "test")
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 3001) });
