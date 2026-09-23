import { describe, it, expect } from "vitest";
import {
  transition,
  outcomeState,
  checkCompleteness,
  identityDecision,
} from "../../packages/domain/src/index.js";
import { evaluateAction } from "../../packages/policy/src/index.js";
describe("referral domain", () => {
  it("allows explicit transitions and rejects stale paths", () => {
    expect(transition("RECEIVED", "DISPATCH_PENDING")).toBe("DISPATCH_PENDING");
    expect(transition("READY", "DISPATCH_PENDING")).toBe("DISPATCH_PENDING");
    expect(() => transition("COMPLETED", "READY")).toThrow();
  });
  it.each([
    ["SUCCEEDED", "COMPLETED"],
    ["RETRYABLE", "DISPATCH_PENDING"],
    ["PERMANENT", "EXCEPTION"],
    ["DEFERRED", "EXCEPTION"],
    ["AMBIGUOUS", "RECONCILING"],
  ] as const)("maps %s without blindly retrying ambiguity", (outcome, state) =>
    expect(outcomeState(outcome)).toBe(state),
  );
  it("abstains for uncertain identity and finds missing documents", () => {
    expect(identityDecision(0.89, "x")).toBe("REVIEW");
    expect(checkCompleteness(["referral_letter"]).missing).toEqual([
      "insurance",
      "demographics",
    ]);
  });
  it("denies action without deterministic prerequisites", () =>
    expect(
      evaluateAction({
        role: "system",
        action: "referral.create",
        complete: false,
        identityResolved: true,
      }).effect,
    ).toBe("DENY"));
});
