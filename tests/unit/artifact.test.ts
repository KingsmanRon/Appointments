import { it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFileStore } from "../../apps/core-api/src/artifact.js";
it("encrypts artifacts and stores plaintext digest only as metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "access-"));
  const bytes = Buffer.from("synthetic referral");
  const result = await new EncryptedFileStore(root, Buffer.alloc(32, 7)).put({
    tenantId: "tenant",
    referralId: "referral",
    bytes,
  });
  const disk = await readFile(join(root, result.objectKey));
  expect(disk.includes(bytes)).toBe(false);
  expect(result.digest).toHaveLength(64);
});
