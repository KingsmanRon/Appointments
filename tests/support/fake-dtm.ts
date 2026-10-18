import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * A stand-in for DTM's ACCESS integration API, written from DTM's contract
 * (docs/connectors/dtm.md; src/lib/integrations/access in
 * KingsmanRon/dtm-inc). It checks signatures with its own code, not the
 * connector's, applies DTM's strict delivery schema, stores each execution
 * once, and can be scripted to fail the way a real deployment can.
 */
export type DtmFault =
  /** Stores the delivery, then never answers: the client times out. */
  | "store-then-hang"
  /** Stores, then answers 500 (e.g. the audit write failed). */
  | "store-then-500"
  /** Stores, then drops the connection without an answer. */
  | "store-then-reset"
  /** Stores, then answers 201 with a body that is not a receipt. */
  | "store-then-malformed"
  /** Stores, then answers with a body far larger than any receipt. */
  | "store-then-huge"
  /** 500 before storing (e.g. the database was unavailable). */
  | "error-500"
  /** The integration is switched off: 503 before anything else. */
  | "disabled-503"
  /** A gateway's 503 or 429: the request never reached DTM's handler. */
  | "gateway-503"
  | "gateway-429"
  /** A gateway redirect, e.g. to another host name. */
  | "redirect-307";

export interface StoredDelivery {
  executionId: string;
  reference: string;
  hash: string;
  status: "pending" | "accepted" | "declined";
  deliveredAt: string;
  resolvedAt: string | null;
  body: Record<string, unknown>;
}

const PATH = "/api/v1/integrations/access/referrals";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DOCUMENTS = new Set([
  "referral_letter",
  "insurance",
  "demographics",
  "medical_aid_card",
  "identity_document",
  "consent_form",
  "prior_results",
]);

export class FakeDtm {
  readonly stored = new Map<string, StoredDelivery>();
  /** Every POST that reached the fake, whatever happened to it. */
  posts = 0;
  gets = 0;
  lastHeaders: IncomingHttpHeaders | undefined;
  lastBody: Record<string, unknown> | undefined;
  baseUrl = "";
  private faults: DtmFault[] = [];
  private sockets = new Set<Socket>();
  private server: Server;

  private constructor(
    readonly options: {
      keyId: string;
      secret: string;
      tenantId: string;
      dataMode: "SYNTHETIC" | "REAL";
    },
  ) {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
  }

  static async start(options: {
    keyId?: string;
    secret?: string;
    tenantId: string;
    dataMode?: "SYNTHETIC" | "REAL";
  }): Promise<FakeDtm> {
    const fake = new FakeDtm({
      keyId: options.keyId ?? "test-key",
      secret: options.secret ?? "fake-dtm-secret-0123456789abcdefghij",
      tenantId: options.tenantId,
      dataMode: options.dataMode ?? "SYNTHETIC",
    });
    await new Promise<void>((resolve) =>
      fake.server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = fake.server.address() as AddressInfo;
    fake.baseUrl = `http://127.0.0.1:${port}`;
    return fake;
  }

  /** Faults for the next POSTs, one each, in order. */
  failNext(...faults: DtmFault[]) {
    this.faults.push(...faults);
  }
  /** Reception links or declines an inbox referral. */
  resolve(reference: string, status: "accepted" | "declined") {
    for (const row of this.stored.values())
      if (row.reference === reference) {
        row.status = status;
        row.resolvedAt = new Date().toISOString();
      }
  }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fake.invalid");
    const pathWithQuery = `${url.pathname}${url.search}`;
    if (req.method === "POST" && url.pathname === PATH) {
      this.posts++;
      return this.post(req, res, body, pathWithQuery);
    }
    if (req.method === "GET" && url.pathname.startsWith(PATH)) {
      this.gets++;
      if (!this.verify(req, pathWithQuery, body))
        return json(res, 401, { error: "unauthorised" });
      const key = url.pathname.slice(PATH.length);
      const row =
        key === ""
          ? [...this.stored.values()].find(
              (r) => r.reference === url.searchParams.get("reference"),
            )
          : this.stored.get(decodeURIComponent(key.slice(1)).toLowerCase());
      if (!row) return json(res, 404, { error: "not_found" });
      return json(res, 200, {
        schema_version: "access-referral-status.v1",
        execution_id: row.executionId,
        reference: row.reference,
        status: row.status,
        delivered_at: row.deliveredAt,
        resolved_at: row.resolvedAt,
      });
    }
    res.writeHead(404, { "content-type": "text/html" });
    res.end("<!doctype html><title>404</title>");
  }

  private post(
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
    pathWithQuery: string,
  ) {
    const fault = this.faults.shift();
    if (fault === "gateway-503") return text(res, 503, "Service Unavailable");
    if (fault === "gateway-429") return text(res, 429, "Too Many Requests");
    if (fault === "redirect-307") {
      res.writeHead(307, { location: `${this.baseUrl}/elsewhere` });
      return res.end();
    }
    if (fault === "disabled-503")
      return json(res, 503, { error: "integration_disabled" });
    if (!this.verify(req, pathWithQuery, body))
      return json(res, 401, { error: "unauthorised" });
    let delivery: Record<string, unknown>;
    try {
      delivery = JSON.parse(body);
    } catch {
      return json(res, 400, { error: "invalid_json" });
    }
    this.lastHeaders = req.headers;
    this.lastBody = delivery;
    const issues = deliveryIssues(delivery);
    if (issues.length)
      return json(res, 422, { error: "validation_error", issues });
    const executionId = String(delivery.execution_id).toLowerCase();
    const idempotencyKey = req.headers["idempotency-key"];
    if (
      typeof idempotencyKey === "string" &&
      idempotencyKey.toLowerCase() !== executionId
    )
      return json(res, 400, { error: "idempotency_key_mismatch" });
    if (
      String(delivery.access_tenant_id).toLowerCase() !==
      this.options.tenantId.toLowerCase()
    )
      return json(res, 403, { error: "tenant_not_allowed" });
    if (delivery.data_mode !== this.options.dataMode)
      return json(res, 409, { error: "data_mode_mismatch" });
    if (fault === "error-500")
      return json(res, 500, { error: "internal_error" });

    const hash = createHash("sha256")
      .update(canonicalJson(delivery))
      .digest("hex");
    const existing = this.stored.get(executionId);
    if (existing && existing.hash !== hash)
      return json(res, 409, {
        error: "idempotency_conflict",
        reference: existing.reference,
      });
    const row = existing ?? {
      executionId,
      reference: `IN-${String(this.stored.size + 1).padStart(6, "0")}`,
      hash,
      status: "pending" as const,
      deliveredAt: new Date().toISOString(),
      resolvedAt: null,
      body: delivery,
    };
    this.stored.set(executionId, row);

    if (fault === "store-then-hang") return;
    if (fault === "store-then-reset") return void req.socket.destroy();
    if (fault === "store-then-500")
      return json(res, 500, { error: "internal_error" });
    if (fault === "store-then-malformed") return json(res, 201, { ok: true });
    if (fault === "store-then-huge")
      return json(res, 201, { padding: "x".repeat(200_000) });
    return json(res, existing ? 200 : 201, {
      schema_version: "access-referral-receipt.v1",
      execution_id: executionId,
      reference: row.reference,
      status: row.status,
      delivered_at: row.deliveredAt,
      deduplicated: Boolean(existing),
    });
  }

  private verify(
    req: IncomingMessage,
    pathWithQuery: string,
    body: string,
  ): boolean {
    const keyId = req.headers["x-access-key-id"];
    const timestamp = req.headers["x-access-timestamp"];
    const signature = req.headers["x-access-signature"];
    if (
      keyId !== this.options.keyId ||
      typeof timestamp !== "string" ||
      typeof signature !== "string" ||
      !/^\d{10}$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    )
      return false;
    const canonical = [
      "access-dtm-v1",
      req.method ?? "",
      pathWithQuery,
      timestamp,
      createHash("sha256").update(body, "utf8").digest("hex"),
    ].join("\n");
    const expected = `v1=${createHmac("sha256", this.options.secret).update(canonical, "utf8").digest("hex")}`;
    return (
      expected.length === signature.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    );
  }
}

/** DTM's strict delivery schema (access-referral-delivery.v1), as issue paths. */
export function deliveryIssues(d: Record<string, unknown>): string[] {
  const issues: string[] = [];
  const check = (ok: boolean, path: string) => ok || issues.push(path);
  const only = (
    value: unknown,
    path: string,
    required: string[],
    optional: string[] = [],
  ): value is Record<string, unknown> => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      issues.push(path);
      return false;
    }
    const keys = Object.keys(value);
    for (const k of keys)
      check(required.includes(k) || optional.includes(k), `${path}.${k}`);
    for (const k of required) check(keys.includes(k), `${path}.${k}`);
    return true;
  };
  const str = (v: unknown, re: RegExp, max = 200) =>
    typeof v === "string" && v.length <= max && re.test(v);
  const name = (v: unknown) =>
    typeof v === "string" &&
    v.trim().length > 0 &&
    v.length <= 200 &&
    !hasControl(v);
  if (
    !only(d, "$", [
      "schema_version",
      "execution_id",
      "correlation_id",
      "access_tenant_id",
      "data_mode",
      "referral",
    ])
  )
    return issues;
  check(d.schema_version === "access-referral-delivery.v1", "schema_version");
  for (const k of ["execution_id", "correlation_id", "access_tenant_id"])
    check(str(d[k], UUID), k);
  check(d.data_mode === "SYNTHETIC" || d.data_mode === "REAL", "data_mode");
  const r = d.referral;
  if (
    !only(
      r,
      "referral",
      [
        "case_reference",
        "referral_id",
        "received_at",
        "patient",
        "referrer",
        "documents_held",
      ],
      ["reason", "requested_service", "referral_date", "funding"],
    )
  )
    return issues;
  check(str(r.case_reference, /^REF-[0-9A-F]{8}$/), "referral.case_reference");
  check(str(r.referral_id, UUID), "referral.referral_id");
  check(
    typeof r.received_at === "string" &&
      !Number.isNaN(Date.parse(r.received_at)),
    "referral.received_at",
  );
  if (
    only(
      r.patient,
      "referral.patient",
      ["given_name", "family_name", "date_of_birth"],
      ["identifier"],
    )
  ) {
    const p = r.patient;
    check(name(p.given_name), "referral.patient.given_name");
    check(name(p.family_name), "referral.patient.family_name");
    check(str(p.date_of_birth, DATE), "referral.patient.date_of_birth");
    if ("identifier" in p)
      check(
        str(p.identifier, /^[A-Za-z0-9][A-Za-z0-9 /-]{0,99}$/),
        "referral.patient.identifier",
      );
  }
  if (only(r.referrer, "referral.referrer", ["name"]))
    check(name(r.referrer.name), "referral.referrer.name");
  if ("reason" in r)
    check(
      typeof r.reason === "string" &&
        r.reason.length <= 4000 &&
        !hasControl(r.reason, "\t\n\r"),
      "referral.reason",
    );
  if ("requested_service" in r)
    check(
      str(r.requested_service, /^[A-Z0-9_]{2,64}$/),
      "referral.requested_service",
    );
  if ("referral_date" in r)
    check(str(r.referral_date, DATE), "referral.referral_date");
  if (
    "funding" in r &&
    only(r.funding, "referral.funding", ["type"], ["scheme"])
  ) {
    check(
      ["MEDICAL_AID", "SELF_PAY", "OTHER", "UNKNOWN"].includes(
        r.funding.type as string,
      ),
      "referral.funding.type",
    );
    if ("scheme" in r.funding)
      check(
        name(r.funding.scheme) && String(r.funding.scheme).length <= 120,
        "referral.funding.scheme",
      );
  }
  check(
    Array.isArray(r.documents_held) &&
      r.documents_held.every((doc) => DOCUMENTS.has(doc as string)),
    "referral.documents_held",
  );
  return issues;
}

/** Control characters, other than those `allowed`, as DTM refuses them. */
function hasControl(value: string, allowed = ""): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 || code === 0x7f) && !allowed.includes(ch)) return true;
  }
  return false;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (k) =>
        `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
    )
    .join(",")}}`;
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
}
