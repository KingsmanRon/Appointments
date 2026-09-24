import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
export interface ArtifactStore {
  put(input: { tenantId: string; referralId: string; bytes: Buffer }): Promise<{
    objectKey: string;
    digest: string;
    size: number;
    keyId: string;
    created: boolean;
  }>;
  remove(objectKey: string): Promise<void>;
}
export class EncryptedFileStore implements ArtifactStore {
  constructor(
    private root: string,
    private key: Buffer,
  ) {
    if (key.length !== 32) throw new Error("artifact key must be 32 bytes");
  }
  async put(i: { tenantId: string; referralId: string; bytes: Buffer }) {
    const digest = createHash("sha256").update(i.bytes).digest("hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(i.bytes),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const dir = join(this.root, i.tenantId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const objectKey = `${i.tenantId}/${i.referralId}-${digest}.enc`;
    let created = true;
    try {
      await writeFile(
        join(this.root, objectKey),
        Buffer.concat([iv, encrypted]),
        { mode: 0o600, flag: "wx" },
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") created = false;
      else throw e;
    }
    return {
      objectKey,
      digest,
      size: i.bytes.length,
      keyId: "local-aes-v1",
      created,
    };
  }
  async remove(objectKey: string) {
    try {
      await unlink(join(this.root, objectKey));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
}
