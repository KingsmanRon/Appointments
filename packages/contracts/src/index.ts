import { z } from "zod";
export const uuid = z.string().uuid();
export const actorSchema = z.object({
  kind: z.enum(["staff", "system", "connector"]),
  id: z.string().min(1).max(100),
});
export const commandSchema = z
  .object({
    schema_version: z.literal("command.v1"),
    command_id: uuid,
    tenant_id: uuid,
    type: z.enum(["referral.ingest", "work.resolve", "execution.result"]),
    actor: actorSchema,
    subject: z.object({ kind: z.literal("referral"), id: uuid }),
    correlation_id: uuid,
    causation_id: uuid.nullable(),
    expected_version: z.number().int().nonnegative(),
    issued_at: z.iso.datetime(),
    payload: z.record(z.string(), z.unknown()),
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();
export type Command = z.infer<typeof commandSchema>;
export const extractedReferralSchema = z
  .object({
    schema_version: z.literal("referral-extraction.v1"),
    patient: {
      given_name: z.string().min(1),
      family_name: z.string().min(1),
      date_of_birth: z.iso.date(),
      external_id: z.string().min(1).optional(),
    },
    referrer: { name: z.string().min(1) },
    reason: z.string().min(1),
    documents: z.array(
      z.enum(["referral_letter", "insurance", "demographics"]),
    ),
    confidence: z.number().min(0).max(1),
  })
  .strict();
export type ExtractedReferral = z.infer<typeof extractedReferralSchema>;
export const connectorResultSchema = z.discriminatedUnion("status", [
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("SUCCEEDED"),
    external_id: z.string(),
  }),
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("RETRYABLE"),
    code: z.string(),
  }),
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("PERMANENT"),
    code: z.string(),
  }),
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("DEFERRED"),
    descriptor: z.string(),
  }),
  z.object({
    schema_version: z.literal("connector-result.v1"),
    execution_id: uuid,
    status: z.literal("AMBIGUOUS"),
    unknown: z.string(),
  }),
]);
export type ConnectorResult = z.infer<typeof connectorResultSchema>;
export const ingestRequestSchema = z
  .object({
    command_id: uuid,
    tenant_id: uuid,
    referral_id: uuid,
    correlation_id: uuid,
    expected_version: z.literal(0),
    filename: z.string().regex(/^[a-zA-Z0-9_.-]{1,120}$/),
    media_type: z.enum(["application/pdf", "application/json", "text/plain"]),
    content_base64: z.string().min(1).max(14_000_000),
    fixture: z
      .enum(["complete", "missing-insurance", "ambiguous-identity", "urgent"])
      .default("complete"),
  })
  .strict();
export const resolutionSchema = z
  .object({
    command_id: uuid,
    correlation_id: uuid,
    expected_version: z.number().int().positive(),
    resolution: z.enum([
      "confirm_identity",
      "provide_insurance",
      "approve_deferred",
      "reject",
    ]),
    note: z.string().min(1).max(500),
  })
  .strict();
