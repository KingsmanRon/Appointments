import type { ExtractedReferral } from "@access/contracts";
export interface ExtractionPort {
  extract(bytes: Uint8Array, fixture: string): Promise<ExtractedReferral>;
}
export class FixtureExtractor implements ExtractionPort {
  async extract(
    _bytes: Uint8Array,
    fixture: string,
  ): Promise<ExtractedReferral> {
    const base: ExtractedReferral = {
      schema_version: "referral-extraction.v1",
      patient: {
        given_name: "Synthetic",
        family_name: "Patient",
        date_of_birth: "1980-01-01",
        external_id: "SYN-001",
      },
      referrer: { name: "Dr Fixture" },
      reason: "Synthetic knee assessment",
      documents: ["referral_letter", "insurance", "demographics"],
      confidence: 0.98,
    };
    if (fixture === "missing-insurance")
      base.documents = ["referral_letter", "demographics"];
    if (fixture === "ambiguous-identity") {
      delete base.patient.external_id;
      base.confidence = 0.55;
    }
    if (fixture === "urgent")
      throw Object.assign(
        new Error("clinical or urgent content outside administrative scope"),
        { code: "URGENT_CONTENT" },
      );
    return base;
  }
}
