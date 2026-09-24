import { it, expect } from "vitest";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedFileStore } from "../../apps/core-api/src/artifact.js";
import { decodeArtifact } from "../../apps/core-api/src/service.js";
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
  await new EncryptedFileStore(root, Buffer.alloc(32, 7)).remove(
    result.objectKey,
  );
  await expect(access(join(root, result.objectKey))).rejects.toThrow();
});
it("strictly validates decoded artifact boundaries", () => {
  expect(() => decodeArtifact("%%%not-base64%%%")).toThrow("malformed");
  expect(() => decodeArtifact("")).toThrow("size");
  expect(
    decodeArtifact(Buffer.alloc(10_000_000).toString("base64")),
  ).toHaveLength(10_000_000);
  expect(() =>
    decodeArtifact(Buffer.alloc(10_000_001).toString("base64")),
  ).toThrow("size");
});
