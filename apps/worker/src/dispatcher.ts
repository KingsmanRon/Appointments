import type { Pool } from "pg";
import { connectorResultSchema, type ConnectorResult } from "@access/contracts";
import { log } from "@access/observability";
import { appendEvidenceEvent, tenantTx, transitionReferral } from "@access/db";
import type { Connector } from "./connector.js";

interface OutboxItem {
  id: string;
  tenant_id: string;
  referral_id: string;
  execution_id: string;
  payload: { execution_id: string; referral_id: string };
  correlation_id: string;
  attempts: number;
  created_at: Date;
}
export class Dispatcher {
  private maxDispatch = Number(process.env.DISPATCH_MAX_ATTEMPTS ?? 5);
  private maxReconcile = Number(process.env.RECONCILE_MAX_ATTEMPTS ?? 5);
  private reconcileBaseSeconds = Number(
    process.env.RECONCILE_BASE_SECONDS ?? 5,
  );
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
  private async claimAndDispatch(tenantId: string) {
    let item: OutboxItem | undefined;
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const claimed = await c.query<OutboxItem>(
        `SELECT o.id,o.tenant_id,o.referral_id,o.execution_id,o.payload,o.correlation_id,o.attempts,o.created_at FROM outbox o WHERE o.tenant_id=$1 AND (o.status='PENDING' OR (o.status='LEASED' AND o.lease_until<now())) AND o.available_at<=now() AND NOT EXISTS(SELECT 1 FROM outbox earlier WHERE earlier.tenant_id=o.tenant_id AND earlier.referral_id=o.referral_id AND earlier.status IN ('PENDING','LEASED') AND earlier.aggregate_version<o.aggregate_version) ORDER BY o.id FOR UPDATE SKIP LOCKED LIMIT 1`,
        [tenantId],
      );
      item = claimed.rows[0];
      if (!item) {
        await c.query("COMMIT");
        return false;
      }
      item.attempts++;
      await c.query(
        "UPDATE outbox SET status='LEASED',lease_until=now()+interval '30 seconds',attempts=attempts+1 WHERE tenant_id=$1 AND id=$2",
        [tenantId, item.id],
      );
      await c.query("COMMIT");
      log("info", "outbox_claimed", {
        execution_id: item.execution_id,
        correlation_id: item.correlation_id,
        retry_attempt: item.attempts,
        queue_age_ms: Date.now() - new Date(item.created_at).getTime(),
      });
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
    let result: ConnectorResult;
    try {
      result = connectorResultSchema.parse(
        await this.connector.execute(item.payload),
      );
    } catch (e) {
      await this.retryOrPoison(item, String(e));
      return true;
    }
    if (result.status === "RETRYABLE") {
      await this.retryOrPoison(item, result.code);
      return true;
    }
    await this.applyTerminal(item, result);
    return true;
  }
  private async retryOrPoison(item: OutboxItem, error: string) {
    await tenantTx(item.tenant_id, async (c) => {
      if (item.attempts < this.maxDispatch) {
        await c.query(
          "UPDATE outbox SET status='PENDING',available_at=now()+interval '5 seconds',lease_until=null,last_error=$3 WHERE tenant_id=$1 AND id=$2",
          [item.tenant_id, item.id, error],
        );
        log("warn", "dispatch_retry_scheduled", {
          execution_id: item.execution_id,
          correlation_id: item.correlation_id,
          retry_attempt: item.attempts,
        });
        return;
      }
      const locked = await c.query<{ status: string }>(
        "SELECT status FROM outbox WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [item.tenant_id, item.id],
      );
      if (locked.rows[0]?.status === "POISON") return;
      const version = await transitionReferral(c, {
        tenantId: item.tenant_id,
        referralId: item.referral_id,
        to: "EXCEPTION",
      });
      await c.query(
        "UPDATE outbox SET status='POISON',lease_until=null,last_error=$3 WHERE tenant_id=$1 AND id=$2",
        [item.tenant_id, item.id, error],
      );
      await c.query(
        `INSERT INTO executions(id,tenant_id,referral_id,status,attempts,last_error) VALUES($1,$2,$3,'PERMANENT',$4,$5) ON CONFLICT(tenant_id,id) DO UPDATE SET status='PERMANENT',attempts=$4,last_error=$5,updated_at=now()`,
        [
          item.execution_id,
          item.tenant_id,
          item.referral_id,
          item.attempts,
          error,
        ],
      );
      await c.query(
        `INSERT INTO work_items(tenant_id,referral_id,kind,status,reason,evidence) VALUES($1,$2,'CONNECTOR','OPEN','dispatch_poison',$3) ON CONFLICT (tenant_id,referral_id,kind) WHERE status='OPEN' AND kind='CONNECTOR' DO NOTHING`,
        [
          item.tenant_id,
          item.referral_id,
          { execution_id: item.execution_id, attempts: item.attempts, error },
        ],
      );
      await appendEvidenceEvent(c, {
        tenantId: item.tenant_id,
        referralId: item.referral_id,
        aggregateVersion: version,
        eventType: "dispatch_poisoned",
        payload: {
          execution_id: item.execution_id,
          attempts: item.attempts,
          error,
        },
        correlationId: item.correlation_id,
      });
      log("error", "dispatch_became_poison", {
        execution_id: item.execution_id,
        correlation_id: item.correlation_id,
        retry_attempt: item.attempts,
      });
    });
  }
  private async applyTerminal(item: OutboxItem, result: ConnectorResult) {
    await tenantTx(item.tenant_id, async (c) => {
      const active = await c.query(
        "SELECT 1 FROM outbox WHERE tenant_id=$1 AND id=$2 AND status='LEASED' FOR UPDATE",
        [item.tenant_id, item.id],
      );
      if (!active.rowCount) return;
      const state =
        result.status === "SUCCEEDED"
          ? "COMPLETED"
          : result.status === "AMBIGUOUS"
            ? "RECONCILING"
            : "EXCEPTION";
      const version = await transitionReferral(c, {
        tenantId: item.tenant_id,
        referralId: item.referral_id,
        to: state,
        externalId: result.status === "SUCCEEDED" ? result.external_id : null,
      });
      await c.query(
        `INSERT INTO executions(id,tenant_id,referral_id,status,attempts,external_id,last_error,reconcile_attempts,first_ambiguous_at,next_reconcile_at) VALUES($1,$2,$3,$4,1,$5,$6,0,CASE WHEN $4='AMBIGUOUS' THEN now() END,CASE WHEN $4='AMBIGUOUS' THEN now()+($7||' seconds')::interval END) ON CONFLICT(tenant_id,id) DO UPDATE SET status=excluded.status,attempts=executions.attempts+1,external_id=excluded.external_id,last_error=excluded.last_error,updated_at=now()`,
        [
          item.execution_id,
          item.tenant_id,
          item.referral_id,
          result.status,
          result.status === "SUCCEEDED" ? result.external_id : null,
          result.status === "AMBIGUOUS"
            ? result.unknown
            : result.status === "PERMANENT"
              ? result.code
              : null,
          this.reconcileBaseSeconds,
        ],
      );
      await appendEvidenceEvent(c, {
        tenantId: item.tenant_id,
        referralId: item.referral_id,
        aggregateVersion: version,
        eventType: `connector_${result.status.toLowerCase()}`,
        payload: result,
        correlationId: item.correlation_id,
      });
      if (result.status === "PERMANENT" || result.status === "DEFERRED")
        await c.query(
          `INSERT INTO work_items(tenant_id,referral_id,kind,status,reason,evidence) VALUES($1,$2,'CONNECTOR','OPEN',$3,$4) ON CONFLICT (tenant_id,referral_id,kind) WHERE status='OPEN' AND kind='CONNECTOR' DO NOTHING`,
          [
            item.tenant_id,
            item.referral_id,
            result.status.toLowerCase(),
            result,
          ],
        );
      await c.query(
        "UPDATE outbox SET status='DONE',lease_until=null WHERE tenant_id=$1 AND id=$2",
        [item.tenant_id, item.id],
      );
      log(
        "info",
        result.status === "AMBIGUOUS"
          ? "ambiguous_execution_detected"
          : "dispatch_succeeded",
        {
          execution_id: item.execution_id,
          correlation_id: item.correlation_id,
          status: result.status,
        },
      );
    });
  }
  async reconcile(): Promise<number> {
    const tenants = await this.pool.query<{ id: string }>(
      "SELECT id FROM organisations ORDER BY id",
    );
    let count = 0;
    for (const tenant of tenants.rows) {
      const due = await tenantTx(tenant.id, (c) =>
        c.query<{
          id: string;
          tenant_id: string;
          referral_id: string;
          reconcile_attempts: number;
          correlation_id: string;
        }>(
          `SELECT e.id,e.tenant_id,e.referral_id,e.reconcile_attempts,o.correlation_id FROM executions e JOIN outbox o ON o.tenant_id=e.tenant_id AND o.execution_id=e.id WHERE e.tenant_id=$1 AND e.status='AMBIGUOUS' AND e.next_reconcile_at<=now() ORDER BY e.next_reconcile_at LIMIT 20`,
          [tenant.id],
        ),
      );
      for (const x of due.rows) {
        log("info", "reconciliation_attempted", {
          execution_id: x.id,
          correlation_id: x.correlation_id,
          retry_attempt: x.reconcile_attempts + 1,
        });
        const result = connectorResultSchema.parse(
          await this.connector.reconcile(x.id),
        );
        await this.applyReconcile(x, result);
        count++;
      }
    }
    return count;
  }
  private async applyReconcile(
    x: {
      id: string;
      tenant_id: string;
      referral_id: string;
      reconcile_attempts: number;
      correlation_id: string;
    },
    result: ConnectorResult,
  ) {
    await tenantTx(x.tenant_id, async (c) => {
      const attempt = x.reconcile_attempts + 1;
      if (result.status === "AMBIGUOUS" && attempt < this.maxReconcile) {
        const delay = Math.min(
          300,
          this.reconcileBaseSeconds * 2 ** (attempt - 1),
        );
        await c.query(
          "UPDATE executions SET reconcile_attempts=$1,last_reconcile_at=now(),next_reconcile_at=now()+($2||' seconds')::interval,last_error=$3,updated_at=now() WHERE tenant_id=$4 AND id=$5 AND status='AMBIGUOUS'",
          [attempt, delay, result.unknown, x.tenant_id, x.id],
        );
        log("warn", "reconciliation_remained_ambiguous", {
          execution_id: x.id,
          correlation_id: x.correlation_id,
          retry_attempt: attempt,
        });
        return;
      }
      const success = result.status === "SUCCEEDED";
      const version = await transitionReferral(c, {
        tenantId: x.tenant_id,
        referralId: x.referral_id,
        to: success ? "COMPLETED" : "EXCEPTION",
        externalId: success ? result.external_id : null,
      });
      await c.query(
        "UPDATE executions SET status=$1,reconcile_attempts=$2,last_reconcile_at=now(),next_reconcile_at=null,external_id=$3,last_error=$4,updated_at=now() WHERE tenant_id=$5 AND id=$6",
        [
          success ? "SUCCEEDED" : "PERMANENT",
          attempt,
          success ? result.external_id : null,
          success
            ? null
            : result.status === "AMBIGUOUS"
              ? result.unknown
              : "reconciliation_failed",
          x.tenant_id,
          x.id,
        ],
      );
      const event = success
        ? "reconciliation_succeeded"
        : "reconciliation_escalated";
      await appendEvidenceEvent(c, {
        tenantId: x.tenant_id,
        referralId: x.referral_id,
        aggregateVersion: version,
        eventType: event,
        payload: { execution_id: x.id, attempts: attempt, result },
        correlationId: x.correlation_id,
      });
      if (!success)
        await c.query(
          `INSERT INTO work_items(tenant_id,referral_id,kind,status,reason,evidence) VALUES($1,$2,'CONNECTOR','OPEN','reconciliation_exhausted',$3) ON CONFLICT (tenant_id,referral_id,kind) WHERE status='OPEN' AND kind='CONNECTOR' DO NOTHING`,
          [
            x.tenant_id,
            x.referral_id,
            { execution_id: x.id, attempts: attempt },
          ],
        );
      log(success ? "info" : "error", event, {
        execution_id: x.id,
        correlation_id: x.correlation_id,
        retry_attempt: attempt,
      });
    });
  }
}
