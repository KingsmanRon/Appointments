import {
  referralDeliverySchema,
  type AnyExtraction,
  type ReferralDelivery,
} from "@access/contracts";
import type { DbClient } from "@access/db";
import { displayRef } from "@access/domain";
import {
  referralDocuments,
  referralField,
  type ReferralFacts,
  type RuleFieldPath,
} from "@access/rules";

/**
 * The referral a `referral.create` connector sends, built at dispatch from
 * the facts that made it ready, read the way the rules read them. Only
 * connectors that declare `sendsReferralContent` receive it. It lives for
 * the one request: it is never written to the outbox, an execution, evidence
 * or a log.
 */
export async function loadReferralDelivery(
  c: DbClient,
  tenantId: string,
  caseId: string,
): Promise<ReferralDelivery | null> {
  const found = await c.query<{
    id: string;
    extraction: AnyExtraction | null;
    supplied_documents: ReferralFacts["supplied_documents"];
    supplied_fields: ReferralFacts["supplied_fields"];
    identity_confirmed_by: string | null;
    opened_at: Date;
  }>(
    `SELECT r.id,r.extraction,r.supplied_documents,r.supplied_fields,r.identity_confirmed_by,c.opened_at
       FROM referrals r JOIN access_cases c ON c.tenant_id=r.tenant_id AND c.id=r.case_id
      WHERE r.tenant_id=$1 AND r.case_id=$2`,
    [tenantId, caseId],
  );
  const r = found.rows[0];
  if (!r) return null;
  return buildReferralDelivery({
    caseId,
    referralId: r.id,
    receivedAt: r.opened_at,
    facts: {
      extraction: r.extraction,
      supplied_documents: r.supplied_documents,
      supplied_fields: r.supplied_fields,
      identity_confirmed_by_staff: Boolean(r.identity_confirmed_by),
    },
  });
}

/**
 * Null when a fact the delivery needs is missing or out of contract; the
 * referral is then entered at the destination by hand, never sent partially.
 */
export function buildReferralDelivery(input: {
  caseId: string;
  referralId: string;
  receivedAt: Date;
  facts: ReferralFacts;
}): ReferralDelivery | null {
  const field = (path: RuleFieldPath) => referralField(input.facts, path);
  const identifier = field("patient.external_id");
  const fundingType = field("funding.type");
  const fundingScheme = field("funding.scheme");
  const reason = input.facts.extraction?.reason?.trim();
  const candidate = {
    schema_version: "referral-delivery.v1",
    case_reference: displayRef(input.caseId),
    referral_id: input.referralId,
    received_at: input.receivedAt.toISOString(),
    patient: {
      given_name: field("patient.given_name"),
      family_name: field("patient.family_name"),
      date_of_birth: field("patient.date_of_birth"),
      ...(identifier ? { identifier } : {}),
    },
    referrer: { name: field("referrer.name") },
    ...(reason ? { reason } : {}),
    ...optional("requested_service", field("requested_service")),
    ...optional("referral_date", field("referral_date")),
    ...(fundingType
      ? {
          funding: {
            type: fundingType,
            ...(fundingScheme ? { scheme: fundingScheme } : {}),
          },
        }
      : {}),
    documents_held: referralDocuments(input.facts),
  };
  const parsed = referralDeliverySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

function optional<K extends string>(key: K, value: string | undefined) {
  return value ? ({ [key]: value } as Record<K, string>) : {};
}
