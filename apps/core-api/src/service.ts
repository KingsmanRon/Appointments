import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  commandSchema,
  extractedReferralSchema,
  type Command,
} from "@access/contracts";
import { checkCompleteness, identityDecision } from "@access/domain";
import { evaluateAction } from "@access/policy";
import { processCommand, tenantTx } from "@access/db";
import type { ArtifactStore } from "./artifact.js";
import type { ExtractionPort } from "./extraction.js";
export function decodeArtifact(content: string): Buffer {
  if (
    content.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(content) ||
    (content.includes("=") && content.indexOf("=") < content.length - 2)
  )
    throw Object.assign(new Error("malformed base64"), { statusCode: 400 });
  const bytes = Buffer.from(content, "base64");
  if (bytes.toString("base64") !== content)
    throw Object.assign(new Error("malformed base64"), { statusCode: 400 });
  if (bytes.length === 0 || bytes.length > 10_000_000)
    throw Object.assign(new Error("artifact size invalid"), {
      statusCode: 400,
    });
  return bytes;
}
export class ReferralService {
  constructor(
    private db: Pool,
    private artifacts: ArtifactStore,
    private extractor: ExtractionPort,
  ) {}
  async ingest(input: {
    command_id: string;
    tenant_id: string;
    referral_id: string;
    correlation_id: string;
    expected_version: 0;
    filename: string;
    media_type: string;
    content_base64: string;
    fixture: string;
  }) {
    const bytes = decodeArtifact(input.content_base64);
    const stored = await this.artifacts.put({
      tenantId: input.tenant_id,
      referralId: input.referral_id,
      bytes,
    });
    let extracted;
    try {
      extracted = extractedReferralSchema.parse(
        await this.extractor.extract(bytes, input.fixture),
      );
    } catch (e) {
      if ((e as { code?: string }).code !== "URGENT_CONTENT") throw e;
      return tenantTx(input.tenant_id, async (c) => {
        await c.query(
          `INSERT INTO referrals(id,tenant_id,state) VALUES($1,$2,'RECEIVED') ON CONFLICT DO NOTHING`,
          [input.referral_id, input.tenant_id],
        );
        await c.query(
          `INSERT INTO artifacts(tenant_id,referral_id,object_key,digest_sha256,media_type,size_bytes,scan_status,encryption_key_id) VALUES($1,$2,$3,$4,$5,$6,'CLEAN',$7) ON CONFLICT (tenant_id,referral_id,digest_sha256) DO NOTHING`,
          [
            input.tenant_id,
            input.referral_id,
            stored.objectKey,
            stored.digest,
            input.media_type,
            stored.size,
            stored.keyId,
          ],
        );
        const cmd = this.command(input);
        const result = await processCommand(c, cmd, {
          state: "EXCEPTION",
          eventType: "urgent_content_routed",
          event: { scope: "administrative_only" },
        });
        await c.query(
          `INSERT INTO work_items(tenant_id,referral_id,kind,status,reason,evidence) VALUES($1,$2,'SAFETY','OPEN','urgent_or_clinical_content',$3)`,
          [input.tenant_id, input.referral_id, { filename: input.filename }],
        );
        return { state: "EXCEPTION", ...result };
      }).catch(async (error) => {
        if (stored.created) await this.artifacts.remove(stored.objectKey);
        throw error;
      });
    }
    const identity = identityDecision(
      extracted.confidence,
      extracted.patient.external_id,
    );
    const completeness = checkCompleteness(extracted.documents);
    const prerequisiteState =
      identity === "REVIEW"
        ? "IDENTITY_PENDING"
        : !completeness.complete
          ? "ADMIN_PENDING"
          : "READY";
    const policy = evaluateAction({
      role: "system",
      action: "referral.create",
      complete: completeness.complete,
      identityResolved: identity === "RESOLVED",
    });
    const state =
      prerequisiteState === "READY" && policy.effect === "ALLOW"
        ? "DISPATCH_PENDING"
        : prerequisiteState;
    const executionId = randomUUID();
    return tenantTx(input.tenant_id, async (c) => {
      await c.query(
        `INSERT INTO referrals(id,tenant_id,state) VALUES($1,$2,'RECEIVED') ON CONFLICT DO NOTHING`,
        [input.referral_id, input.tenant_id],
      );
      await c.query(
        `INSERT INTO artifacts(tenant_id,referral_id,object_key,digest_sha256,media_type,size_bytes,scan_status,encryption_key_id) VALUES($1,$2,$3,$4,$5,$6,'CLEAN',$7) ON CONFLICT (tenant_id,referral_id,digest_sha256) DO NOTHING`,
        [
          input.tenant_id,
          input.referral_id,
          stored.objectKey,
          stored.digest,
          input.media_type,
          stored.size,
          stored.keyId,
        ],
      );
      const result = await processCommand(c, this.command(input), {
        state,
        eventType: "referral_extracted",
        event: {
          identity,
          completeness,
          policy,
          artifact_digest: stored.digest,
        },
        ...(state === "DISPATCH_PENDING"
          ? {
              outbox: {
                executionId,
                payload: {
                  schema_version: "referral-create.v1",
                  execution_id: executionId,
                  referral_id: input.referral_id,
                },
              },
            }
          : {}),
      });
      await c.query(
        "UPDATE referrals SET extraction=$1,identity_status=$2,policy_decision=$3 WHERE tenant_id=$4 AND id=$5",
        [extracted, identity, policy, input.tenant_id, input.referral_id],
      );
      if (prerequisiteState !== "READY")
        await c.query(
          `INSERT INTO work_items(tenant_id,referral_id,kind,status,reason,evidence) VALUES($1,$2,$3,'OPEN',$4,$5)`,
          [
            input.tenant_id,
            input.referral_id,
            prerequisiteState === "IDENTITY_PENDING"
              ? "IDENTITY"
              : "COMPLETENESS",
            prerequisiteState === "IDENTITY_PENDING"
              ? "identity_uncertain"
              : `missing:${completeness.missing.join(",")}`,
            { confidence: extracted.confidence, missing: completeness.missing },
          ],
        );
      return {
        state,
        execution_id: state === "DISPATCH_PENDING" ? executionId : null,
        ...result,
      };
    }).catch(async (error) => {
      if (stored.created) await this.artifacts.remove(stored.objectKey);
      throw error;
    });
  }
  async resolve(
    tenantId: string,
    referralId: string,
    input: {
      command_id: string;
      correlation_id: string;
      expected_version: number;
      resolution: string;
      note: string;
    },
  ) {
    return tenantTx(tenantId, async (c) => {
      const row = await c.query<{
        extraction: { documents: string[] };
        identity_status: string;
      }>(
        "SELECT extraction,identity_status FROM referrals WHERE tenant_id=$1 AND id=$2",
        [tenantId, referralId],
      );
      if (!row.rowCount)
        throw Object.assign(new Error("not found"), { statusCode: 404 });
      const identity =
        input.resolution === "confirm_identity"
          ? "RESOLVED"
          : row.rows[0]!.identity_status;
      if (
        input.resolution === "provide_insurance" &&
        !row.rows[0]!.extraction.documents.includes("insurance")
      )
        row.rows[0]!.extraction.documents.push("insurance");
      const complete = checkCompleteness(
        row.rows[0]!.extraction.documents,
      ).complete;
      const policy = evaluateAction({
        role: "coordinator",
        action: "referral.create",
        complete,
        identityResolved: identity === "RESOLVED",
      });
      const state =
        input.resolution === "reject"
          ? "REJECTED"
          : policy.effect === "ALLOW"
            ? "DISPATCH_PENDING"
            : identity !== "RESOLVED"
              ? "IDENTITY_PENDING"
              : "ADMIN_PENDING";
      const executionId = randomUUID();
      const cmd = commandSchema.parse({
        schema_version: "command.v1",
        command_id: input.command_id,
        tenant_id: tenantId,
        type: "work.resolve",
        actor: { kind: "staff", id: "local-coordinator" },
        subject: { kind: "referral", id: referralId },
        correlation_id: input.correlation_id,
        causation_id: null,
        expected_version: input.expected_version,
        issued_at: new Date().toISOString(),
        payload: { resolution: input.resolution },
        evidence: { note: input.note },
      });
      const result = await processCommand(c, cmd, {
        state,
        eventType: "work_resolved",
        event: { resolution: input.resolution, policy },
        ...(state === "DISPATCH_PENDING"
          ? {
              outbox: {
                executionId,
                payload: {
                  schema_version: "referral-create.v1",
                  execution_id: executionId,
                  referral_id: referralId,
                },
              },
            }
          : {}),
      });
      await c.query(
        `UPDATE work_items SET status='RESOLVED',resolution=$1,resolved_at=now() WHERE tenant_id=$2 AND referral_id=$3 AND status='OPEN'`,
        [
          { resolution: input.resolution, note: input.note },
          tenantId,
          referralId,
        ],
      );
      await c.query(
        "UPDATE referrals SET extraction=$1,identity_status=$2,policy_decision=$3 WHERE tenant_id=$4 AND id=$5",
        [row.rows[0]!.extraction, identity, policy, tenantId, referralId],
      );
      return {
        state,
        execution_id: state === "DISPATCH_PENDING" ? executionId : null,
        ...result,
      };
    });
  }
  private command(i: {
    command_id: string;
    tenant_id: string;
    referral_id: string;
    correlation_id: string;
    expected_version: number;
  }): Command {
    return commandSchema.parse({
      schema_version: "command.v1",
      command_id: i.command_id,
      tenant_id: i.tenant_id,
      type: "referral.ingest",
      actor: { kind: "staff", id: "local-uploader" },
      subject: { kind: "referral", id: i.referral_id },
      correlation_id: i.correlation_id,
      causation_id: null,
      expected_version: i.expected_version,
      issued_at: new Date().toISOString(),
      payload: {},
      evidence: {},
    });
  }
}
