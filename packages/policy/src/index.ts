export type Decision = {
  effect: "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
  policyVersion: "action-policy.v1";
  reason: string;
};
export function evaluateAction(input: {
  role: string;
  action: string;
  complete: boolean;
  identityResolved: boolean;
}): Decision {
  if (input.action !== "referral.create")
    return {
      effect: "DENY",
      policyVersion: "action-policy.v1",
      reason: "unknown action",
    };
  if (!input.complete || !input.identityResolved)
    return {
      effect: "DENY",
      policyVersion: "action-policy.v1",
      reason: "requirements unmet",
    };
  if (!["system", "coordinator"].includes(input.role))
    return {
      effect: "REQUIRE_APPROVAL",
      policyVersion: "action-policy.v1",
      reason: "staff approval required",
    };
  return {
    effect: "ALLOW",
    policyVersion: "action-policy.v1",
    reason: "administrative referral creation permitted",
  };
}
