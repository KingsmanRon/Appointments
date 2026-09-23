import { it, expect } from "vitest";
import {
  connectorResultSchema,
  ingestRequestSchema,
} from "../../packages/contracts/src/index.js";
it("rejects unversioned and unknown external input", () => {
  expect(() => connectorResultSchema.parse({ status: "OK" })).toThrow();
  expect(() => ingestRequestSchema.parse({ unexpected: true })).toThrow();
});
