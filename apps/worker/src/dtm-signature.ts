import { createHash, createHmac } from "node:crypto";

/**
 * Request signing for the DTM integration API. DTM recomputes the signature
 * (src/lib/integrations/access/signature.ts in KingsmanRon/dtm-inc) and
 * refuses a request that does not match, names an unknown key, or is more
 * than five minutes from its clock. Both repositories test the same fixed
 * vector; changing the canonical string needs a new scheme on both sides.
 */
export const SIGNATURE_SCHEME = "access-dtm-v1";
export const HEADER_KEY_ID = "x-access-key-id";
export const HEADER_TIMESTAMP = "x-access-timestamp";
export const HEADER_SIGNATURE = "x-access-signature";

export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** The exact text both sides sign, one field per line. */
export function canonicalRequest(input: {
  method: string;
  pathWithQuery: string;
  timestamp: string;
  bodySha256: string;
}): string {
  return [
    SIGNATURE_SCHEME,
    input.method.toUpperCase(),
    input.pathWithQuery,
    input.timestamp,
    input.bodySha256,
  ].join("\n");
}

/** `v1=<hex HMAC-SHA256>` of the canonical request. */
export function signCanonical(secret: string, canonical: string): string {
  return `v1=${createHmac("sha256", secret).update(canonical, "utf8").digest("hex")}`;
}

/** Headers that authenticate one request; the body is "" for a GET. */
export function signRequest(input: {
  keyId: string;
  secret: string;
  method: string;
  pathWithQuery: string;
  body: string;
  now: Date;
}): Record<string, string> {
  const timestamp = String(Math.floor(input.now.getTime() / 1000));
  return {
    [HEADER_KEY_ID]: input.keyId,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_SIGNATURE]: signCanonical(
      input.secret,
      canonicalRequest({
        method: input.method,
        pathWithQuery: input.pathWithQuery,
        timestamp,
        bodySha256: sha256Hex(input.body),
      }),
    ),
  };
}
