import { describe, expect, it } from "vitest";
import {
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  canonicalRequest,
  sha256Hex,
  signCanonical,
  signRequest,
} from "../../apps/worker/src/dtm-signature.js";

// The same vector is tested by DTM (src/lib/integrations/access/
// signature.test.ts in KingsmanRon/dtm-inc): if either side changes how it
// signs, one of the two suites fails.
const VECTOR = {
  secret: "dtm-test-vector-secret-0123456789abcdef",
  timestamp: "1792224000",
  post: {
    path: "/api/v1/integrations/access/referrals",
    body: '{"schema_version":"access-referral-delivery.v1"}',
    bodySha256:
      "fb2958fc6206eb0e042736bbb920999321ed28c0c29e53317eb385cff7227949",
    signature:
      "v1=6d8e2a8cc0f77c141bfc4036458cd389bd1c152cad04f09c478838b600af52c2",
  },
  get: {
    path: "/api/v1/integrations/access/referrals/0b4c1f2e-8d3a-4c5b-9e6f-7a8b9c0d1e2f",
    signature:
      "v1=13cd00c159e89530ce66935ada65ebd0ea70069993d9d5ddd9c0eba519b53766",
  },
};

describe("DTM request signing", () => {
  it("matches the vector shared with DTM for a delivery and a read-back", () => {
    expect(sha256Hex(VECTOR.post.body)).toBe(VECTOR.post.bodySha256);
    const post = canonicalRequest({
      method: "post",
      pathWithQuery: VECTOR.post.path,
      timestamp: VECTOR.timestamp,
      bodySha256: VECTOR.post.bodySha256,
    });
    expect(post.split("\n")).toEqual([
      "access-dtm-v1",
      "POST",
      VECTOR.post.path,
      VECTOR.timestamp,
      VECTOR.post.bodySha256,
    ]);
    expect(signCanonical(VECTOR.secret, post)).toBe(VECTOR.post.signature);
    const get = canonicalRequest({
      method: "GET",
      pathWithQuery: VECTOR.get.path,
      timestamp: VECTOR.timestamp,
      bodySha256: sha256Hex(""),
    });
    expect(signCanonical(VECTOR.secret, get)).toBe(VECTOR.get.signature);
  });

  it("signs with the key id and the time in whole unix seconds", () => {
    const headers = signRequest({
      keyId: "2026-10",
      secret: VECTOR.secret,
      method: "POST",
      pathWithQuery: VECTOR.post.path,
      body: VECTOR.post.body,
      now: new Date(Number(VECTOR.timestamp) * 1000 + 999),
    });
    expect(headers).toEqual({
      [HEADER_KEY_ID]: "2026-10",
      [HEADER_TIMESTAMP]: VECTOR.timestamp,
      [HEADER_SIGNATURE]: VECTOR.post.signature,
    });
  });
});
