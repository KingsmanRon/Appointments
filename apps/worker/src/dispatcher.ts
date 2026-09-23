import type { Pool } from "pg";
import { connectorResultSchema } from "@access/contracts";
import { log } from "@access/observability";
import type { Connector } from "./connector.js";
import { tenantTx } from "@access/db";
export class Dispatcher {
  constructor(
    private pool: Pool,
    private connector: Connector,
  ) {}
  async tick(): Promise<boolean> {
    const tenants = await this.pool.query<{ id: string }>(
      "SELECT id FROM organisations ORDER BY id",
    );
    for (const tenant of tenants.rows)
      if (await this.claimAndDispatch(tenant.id)) return true;
    return false;
  }
  private async claimAndDispatch(tenantId: string): Promise<boolean> {
    const c = await this.pool.connect();
    let item: OutboxItem | undefined;
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const claimed = await c.query<OutboxItem>(
        `SELECT o.id,o.tenant_id,o.referral_id,o.execution_id,o.payload,o.correlation_id FROM outbox o WHERE o.tenant_id=$1 AND (o.status='PENDING' OR (o.status='LEASED' AND o.lease_until<now())) AND o.available_at<=now() AND NOT EXISTS(SELECT 1 FROM outbox earlier WHERE earlier.tenant_id=o.tenant_id AND earlier.referral_id=o.referral_id AND (earlier.status='PENDING' OR (earlier.status='LEASED' AND earlier.lease_until>=now())) AND earlier.aggregate_version<o.aggregate_version) ORDER BY o.id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [tenantId],
      );
      item = claimed.rows[0];
      if (!item) {
        await c.query("COMMIT");
        return false;
      }
      await c.query(
        `UPDATE outbox SET status='LEASED',lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE tenant_id=$1 AND id=$2`,
        [item.tenant_id, item.id],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    let result;
    try {
      result = connectorResultSchema.parse(
        await this.connector.execute(item.payload),
      );
    } catch (e) {
      await this.release(item, String(e));
      return true;
    }
    await this.apply(item, result);
    return true;
  }
  private async release(
    item: { tenant_id: string; id: string },
    error: string,
  ) {
    await tenantTx(item.tenant_id, async (c) => {
      await c.query(
        `UPDATE outbox SET status=CASE WHEN attempts>=5 THEN 'POISON' ELSE 'PENDING' END,available_at=now()+interval '5 seconds',lease_until=null,last_error=$1 WHERE tenant_id=$2 AND id=$3`,
        [error, item.tenant_id, item.id],
      );
    });
  }
  private async apply(
    item: {
      tenant_id: string;
      id: string;
      referral_id: string;
      execution_id: string;
      correlation_id: string;
    },
    result: ReturnType<typeof connectorResultSchema.parse>,
  ) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [
        item.tenant_id,
      ]);
      await c.query(
        `INSERT INTO executions(id,tenant_id,referral_id,status,attempts,external_id,last_error) VALUES($1,$2,$3,$4,1,$5,$6) ON CONFLICT(tenant_id,id) DO UPDATE SET status=excluded.status,attempts=executions.attempts+1,external_id=excluded.external_id,last_error=excluded.last_error,updated_at=now()`,
        [
          item.execution_id,
          item.tenant_id,
          item.referral_id,
          result.status,
          result.status === "SUCCEEDED" ? result.external_id : null,
          result.status === "RETRYABLE" || result.status === "PERMANENT"
            ? result.code
            : result.status === "AMBIGUOUS"
              ? result.unknown
              : null,
        ],
      );
      if (result.status === "RETRYABLE") {
        await c.query(
          `UPDATE outbox SET status=CASE WHEN attempts>=5 THEN 'POISON' ELSE 'PENDING' END,available_at=now()+interval '5 seconds',lease_until=null,last_error=$3 WHERE tenant_id=$1 AND id=$2`,
          [item.tenant_id, item.id, result.code],
        );
        await c.query("COMMIT");
        return;
      }
      const state =
        result.status === "SUCCEEDED"
          ? "COMPLETED"
          : result.status === "AMBIGUOUS"
            ? "RECONCILING"
            : "EXCEPTION";
      await c.query(
        "UPDATE referrals SET state=$1,version=version+1,external_id=$2,updated_at=now() WHERE tenant_id=$3 AND id=$4",
        [
          state,
          result.status === "SUCCEEDED" ? result.external_id : null,
          item.tenant_id,
          item.referral_id,
        ],
      );
      await c.query(
        `INSERT INTO evidence_events(tenant_id,referral_id,sequence,event_type,payload,previous_hash,hash,correlation_id) SELECT $1,$2,version,$3,$4,coalesce((SELECT hash FROM evidence_events WHERE tenant_id=$1 AND referral_id=$2 ORDER BY sequence DESC LIMIT 1),'GENESIS'),encode(digest($5,'sha256'),'hex'),$6 FROM referrals WHERE tenant_id=$1 AND id=$2`,
        [
          item.tenant_id,
          item.referral_id,
          `connector_${result.status.toLowerCase()}`,
          result,
          JSON.stringify(result),
          item.correlation_id,
        ],
      );
      if (result.status === "DEFERRED" || result.status === "PERMANENT")
        await c.query(
          `INSERT INTO work_items(tenant_id,referral_id,kind,status,reason,evidence) VALUES($1,$2,'CONNECTOR','OPEN',$3,$4)`,
          [
            item.tenant_id,
            item.referral_id,
            result.status.toLowerCase(),
            result,
          ],
        );
      await c.query(
        `UPDATE outbox SET status='DONE',lease_until=null WHERE tenant_id=$1 AND id=$2`,
        [item.tenant_id, item.id],
      );
      await c.query("COMMIT");
      log("info", "execution_applied", {
        execution_id: item.execution_id,
        status: result.status,
        correlation_id: item.correlation_id,
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async reconcile(): Promise<number> {
    const tenants = await this.pool.query<{ id: string }>(
      "SELECT id FROM organisations ORDER BY id",
    );
    let reconciled = 0;
    for (const tenant of tenants.rows) {
      const rows = await tenantTx(tenant.id, (c) =>
        c.query<{ tenant_id: string; id: string; referral_id: string }>(
          `SELECT tenant_id,id,referral_id FROM executions WHERE tenant_id=$1 AND status='AMBIGUOUS' ORDER BY updated_at LIMIT 20`,
          [tenant.id],
        ),
      );
      for (const x of rows.rows) {
        const result = connectorResultSchema.parse(
          await this.connector.reconcile(x.id),
        );
        const outboxId = await tenantTx(
          x.tenant_id,
          async (c) =>
            (
              await c.query<{ id: string }>(
                "SELECT id FROM outbox WHERE tenant_id=$1 AND execution_id=$2",
                [x.tenant_id, x.id],
              )
            ).rows[0]!.id,
        );
        await this.apply(
          {
            tenant_id: x.tenant_id,
            id: outboxId,
            referral_id: x.referral_id,
            execution_id: x.id,
            correlation_id: crypto.randomUUID(),
          },
          result,
        );
        reconciled++;
      }
    }
    return reconciled;
  }
}

interface OutboxItem {
  id: string;
  tenant_id: string;
  referral_id: string;
  execution_id: string;
  payload: { execution_id: string; referral_id: string };
  correlation_id: string;
}
