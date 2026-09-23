export type ReferralState =
  | "RECEIVED"
  | "IDENTITY_PENDING"
  | "ADMIN_PENDING"
  | "READY"
  | "DISPATCH_PENDING"
  | "RECONCILING"
  | "COMPLETED"
  | "EXCEPTION"
  | "REJECTED";
export type Outcome =
  | "SUCCEEDED"
  | "RETRYABLE"
  | "PERMANENT"
  | "DEFERRED"
  | "AMBIGUOUS";
const allowed: Record<ReferralState, readonly ReferralState[]> = {
  RECEIVED: [
    "IDENTITY_PENDING",
    "ADMIN_PENDING",
    "READY",
    "DISPATCH_PENDING",
    "EXCEPTION",
  ],
  IDENTITY_PENDING: ["ADMIN_PENDING", "READY", "REJECTED"],
  ADMIN_PENDING: ["READY", "REJECTED"],
  READY: ["DISPATCH_PENDING"],
  DISPATCH_PENDING: [
    "COMPLETED",
    "DISPATCH_PENDING",
    "RECONCILING",
    "EXCEPTION",
  ],
  RECONCILING: ["COMPLETED", "EXCEPTION"],
  COMPLETED: [],
  EXCEPTION: ["READY", "REJECTED"],
  REJECTED: [],
};
export function transition(
  from: ReferralState,
  to: ReferralState,
): ReferralState {
  if (!allowed[from].includes(to))
    throw new Error(`invalid transition ${from} -> ${to}`);
  return to;
}
export function outcomeState(outcome: Outcome): ReferralState {
  switch (outcome) {
    case "SUCCEEDED":
      return "COMPLETED";
    case "RETRYABLE":
      return "DISPATCH_PENDING";
    case "AMBIGUOUS":
      return "RECONCILING";
    case "PERMANENT":
    case "DEFERRED":
      return "EXCEPTION";
  }
}
export interface Completeness {
  complete: boolean;
  missing: string[];
}
export function checkCompleteness(documents: readonly string[]): Completeness {
  const required = ["referral_letter", "insurance", "demographics"];
  const missing = required.filter((x) => !documents.includes(x));
  return { complete: missing.length === 0, missing };
}
export function identityDecision(
  confidence: number,
  externalId?: string,
): "RESOLVED" | "REVIEW" {
  return externalId && confidence >= 0.9 ? "RESOLVED" : "REVIEW";
}
