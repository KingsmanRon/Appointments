import { pool, verifyRuntimeIdentity } from "@access/db";
import { log } from "@access/observability";
import { Dispatcher } from "./dispatcher.js";
import { MockConnector, type FaultMode } from "./connector.js";
const dispatcher = new Dispatcher(
  pool,
  new MockConnector(
    (process.env.CONNECTOR_FAULT_MODE ?? "success") as FaultMode,
  ),
);
if (["staging", "production"].includes(process.env.NODE_ENV ?? ""))
  await verifyRuntimeIdentity(pool, "access_worker");
const delay = Number(process.env.WORKER_POLL_MS ?? 250);
log("info", "worker_started", { delay_ms: delay });
for (;;) {
  try {
    const worked = await dispatcher.tick();
    await dispatcher.reconcile();
    if (!worked) await new Promise((r) => setTimeout(r, delay));
  } catch (e) {
    log("error", "worker_tick_failed", { error: String(e) });
    await new Promise((r) => setTimeout(r, delay));
  }
}
