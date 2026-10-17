import { describe, expect, it } from "vitest";
import type { AnyExtraction } from "../../packages/contracts/src/index.js";
import type { ReferralFacts } from "../../packages/rules/src/index.js";
import { buildReferralDelivery } from "../../apps/worker/src/referral-delivery.js";

const caseId = "1a2b3c4d-0000-4000-8000-000000000001";
const referralId = "5e6f7a8b-0000-4000-8000-000000000002";
const receivedAt = new Date("2026-10-17T07:55:00.000Z");
const v2: AnyExtraction = {
  schema_version: "referral-extraction.v2",
  patient: {
    given_name: "Synthetic",
    family_name: "Patient",
    date_of_birth: "1980-01-01",
    external_id: "SYN-001",
  },
  referrer: { name: "Dr Fixture" },
  reason: "  Synthetic knee assessment  ",
  requested_service: "ORTHO_CONSULT",
  referral_date: "2026-10-15",
  funding: { type: "MEDICAL_AID", scheme: "Synthetic Health" },
  documents: ["referral_letter", "insurance"],
  confidence: 1,
  provenance: "STAFF_ENTERED",
};
const facts = (overrides: Partial<ReferralFacts> = {}): ReferralFacts => ({
  extraction: v2,
  supplied_documents: [],
  supplied_fields: {},
  identity_confirmed_by_staff: false,
  ...overrides,
});
const build = (f: ReferralFacts) =>
  buildReferralDelivery({ caseId, referralId, receivedAt, facts: f });

describe("referral delivery (what a referral.create connector sends)", () => {
  it("carries the facts that made the referral ready", () => {
    expect(build(facts())).toEqual({
      schema_version: "referral-delivery.v1",
      case_reference: "REF-1A2B3C4D",
      referral_id: referralId,
      received_at: "2026-10-17T07:55:00.000Z",
      patient: {
        given_name: "Synthetic",
        family_name: "Patient",
        date_of_birth: "1980-01-01",
        identifier: "SYN-001",
      },
      referrer: { name: "Dr Fixture" },
      reason: "Synthetic knee assessment",
      requested_service: "ORTHO_CONSULT",
      referral_date: "2026-10-15",
      funding: { type: "MEDICAL_AID", scheme: "Synthetic Health" },
      documents_held: ["insurance", "referral_letter"],
    });
  });

  it("reads staff corrections over the extraction, as the rules do", () => {
    const delivery = build(
      facts({
        supplied_documents: ["medical_aid_card", "insurance"],
        supplied_fields: {
          patient_external_id: "8001015009087",
          referrer_name: "Dr Corrected",
          requested_service: "PHYSIO",
          funding: { type: "SELF_PAY" },
        },
      }),
    );
    expect(delivery).toMatchObject({
      patient: { identifier: "8001015009087" },
      referrer: { name: "Dr Corrected" },
      requested_service: "PHYSIO",
      funding: { type: "SELF_PAY" },
      documents_held: ["insurance", "medical_aid_card", "referral_letter"],
    });
    // A funding type from staff replaces the extracted one; the extracted
    // scheme still applies, exactly as the evaluator reads it.
    expect(delivery?.funding).toEqual({
      type: "SELF_PAY",
      scheme: "Synthetic Health",
    });
  });

  it("leaves out what the referral does not say", () => {
    const delivery = build(
      facts({
        extraction: {
          schema_version: "referral-extraction.v1",
          patient: {
            given_name: "Synthetic",
            family_name: "Patient",
            date_of_birth: "1980-01-01",
          },
          referrer: { name: "Dr Fixture" },
          reason: "Synthetic review",
          documents: ["referral_letter"],
          confidence: 0.98,
        },
      }),
    );
    expect(delivery).not.toBeNull();
    expect(Object.keys(delivery!.patient)).toEqual([
      "given_name",
      "family_name",
      "date_of_birth",
    ]);
    for (const key of ["requested_service", "referral_date", "funding"])
      expect(delivery).not.toHaveProperty(key);
  });

  it("refuses to build a partial delivery", () => {
    expect(build(facts({ extraction: null }))).toBeNull();
    expect(
      build(
        facts({
          extraction: { ...v2, patient: { ...v2.patient, given_name: "  " } },
        }),
      ),
    ).toBeNull();
    // Out of contract: never truncated to fit.
    expect(
      build(facts({ extraction: { ...v2, reason: "x".repeat(4001) } })),
    ).toBeNull();
  });
});
