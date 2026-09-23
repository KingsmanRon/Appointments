import { describe, it, expect } from "vitest";
import {
  MockConnector,
  type FaultMode,
} from "../../apps/worker/src/connector.js";
const id = "11111111-1111-4111-8111-111111111111";
describe.each(["success", "retryable", "permanent", "deferred"] as FaultMode[])(
  "%s connector",
  (fault) =>
    it("returns a versioned normalized outcome", async () =>
      expect(
        (
          await new MockConnector(fault).execute({
            execution_id: id,
            referral_id: id,
          })
        ).schema_version,
      ).toBe("connector-result.v1")),
);
it("reconciles committed-then-timeout using the same execution identity without duplicate creation", async () => {
  const c = new MockConnector("committed-timeout");
  expect((await c.execute({ execution_id: id, referral_id: id })).status).toBe(
    "AMBIGUOUS",
  );
  const result = await c.reconcile(id);
  expect(result.status).toBe("SUCCEEDED");
  const duplicate = await c.execute({ execution_id: id, referral_id: id });
  expect(duplicate).toEqual(result);
});
