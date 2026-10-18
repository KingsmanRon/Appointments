import {
  referralDeliverySchema,
  type AppointmentOutcome,
  type ConnectorRequest,
  type ConnectorResult,
  type ReferralStatus,
} from "@access/contracts";
import type { DtmConnectorConfig } from "@access/config";
import {
  AmbiguousConnectorError,
  PermanentConnectorError,
  SafeRetryableConnectorError,
  UnsupportedOperationError,
  type CapabilityDescriptor,
  type Connector,
} from "./connector.js";
import { signRequest } from "./dtm-signature.js";

/**
 * Connector for DTM's ACCESS integration API (docs/connectors/dtm.md).
 *
 * `referral.create` delivers the referral to DTM's Referral inbox, where
 * reception links it to a patient file or declines it. DTM stores a delivery
 * once per execution_id, so a re-send of the same execution is safe; the
 * dispatcher still reads an unclear delivery back rather than re-sending it.
 * Read-back returns the inbox reference and status only: no patient data
 * comes back from DTM.
 */
export const DTM_REFERRALS_PATH = "/api/v1/integrations/access/referrals";
const DELIVERY_SCHEMA_VERSION = "access-referral-delivery.v1";
const RECEIPT_SCHEMA_VERSION = "access-referral-receipt.v1";
const STATUS_SCHEMA_VERSION = "access-referral-status.v1";
const INBOX_REFERENCE = /^IN-\d{6,}$/;
const INBOX_STATUSES = ["pending", "accepted", "declined"] as const;
type InboxStatus = (typeof INBOX_STATUSES)[number];
/** DTM's answers are small; anything larger is not DTM. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Transport failures that happen before any request byte is sent. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

interface DtmResponse {
  status: number;
  /** Parsed JSON object, or null when the body is not a JSON object. */
  json: Record<string, unknown> | null;
}

export interface DtmConnectorOptions extends DtmConnectorConfig {
  dataMode: "SYNTHETIC" | "REAL";
  fetch?: typeof fetch;
  now?: () => Date;
}

export class DtmConnector implements Connector {
  readonly name = "dtm";
  private fetchImpl: typeof fetch;
  private now: () => Date;
  constructor(private options: DtmConnectorOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  capabilities(): CapabilityDescriptor[] {
    return [
      {
        capability: "referral.create",
        idempotentByExecutionId: true,
        sendsReferralContent: true,
      },
      { capability: "referral.status.read", idempotentByExecutionId: true },
    ];
  }

  async execute(request: ConnectorRequest): Promise<ConnectorResult> {
    const id = request.execution_id;
    if (request.operation !== "referral.create")
      return result(id, {
        status: "UNSUPPORTED_OPERATION",
        capability: request.operation,
      });
    const delivery = referralDeliverySchema.safeParse(request.payload.delivery);
    if (!delivery.success)
      throw new PermanentConnectorError(
        "referral content is missing or out of contract",
        "REFERRAL_DELIVERY_INCOMPLETE",
      );
    // DTM's envelope carries its own schema version around the referral.
    const referral: Record<string, unknown> = { ...delivery.data };
    delete referral.schema_version;
    const body = JSON.stringify({
      schema_version: DELIVERY_SCHEMA_VERSION,
      execution_id: id,
      correlation_id: request.correlation_id,
      access_tenant_id: request.tenant_id,
      data_mode: this.options.dataMode,
      referral,
    });
    const response = await this.send("POST", DTM_REFERRALS_PATH, body, id);
    return deliveryResult(id, response);
  }

  async reconcile(request: ConnectorRequest): Promise<ConnectorResult> {
    const id = request.execution_id;
    if (request.operation !== "referral.create")
      throw new UnsupportedOperationError(`${request.operation}:read`);
    let response: DtmResponse;
    try {
      response = await this.send(
        "GET",
        `${DTM_REFERRALS_PATH}/${encodeURIComponent(id)}`,
        "",
      );
    } catch (error) {
      return result(id, {
        status: "AMBIGUOUS",
        unknown: `DTM_READBACK_${codeOf(error)}`,
      });
    }
    const status = response.json;
    if (
      response.status === 200 &&
      status?.schema_version === STATUS_SCHEMA_VERSION &&
      sameId(status.execution_id, id) &&
      isReference(status.reference) &&
      isInboxStatus(status.status)
    )
      return result(id, { status: "SUCCEEDED", external_id: status.reference });
    // DTM's 404 says nothing is stored yet. A delivery still in flight can
    // land within DTM's five-minute signature window, so absence is not
    // proven: keep reading back, and a person decides if it never appears.
    if (response.status === 404 && status?.error === "not_found")
      return result(id, { status: "AMBIGUOUS", unknown: "DTM_NOT_STORED" });
    return result(id, {
      status: "AMBIGUOUS",
      unknown: `DTM_READBACK_HTTP_${response.status}`,
    });
  }

  async getReferralStatus(input: {
    destination_reference: string;
  }): Promise<ReferralStatus> {
    const observed = (status: ReferralStatus["status"]): ReferralStatus => ({
      schema_version: "referral-status.v1",
      destination_reference: input.destination_reference,
      status,
      observed_at: this.now().toISOString(),
    });
    if (!INBOX_REFERENCE.test(input.destination_reference))
      return observed("UNKNOWN");
    let response: DtmResponse;
    try {
      response = await this.send(
        "GET",
        `${DTM_REFERRALS_PATH}?reference=${encodeURIComponent(input.destination_reference)}`,
        "",
      );
    } catch {
      return observed("UNKNOWN");
    }
    const body = response.json;
    if (
      response.status === 200 &&
      body?.schema_version === STATUS_SCHEMA_VERSION &&
      body.reference === input.destination_reference &&
      isInboxStatus(body.status)
    )
      return observed(
        body.status === "pending"
          ? "RECEIVED"
          : body.status === "accepted"
            ? "ACCEPTED"
            : "CLOSED",
      );
    if (response.status === 404 && body?.error === "not_found")
      return observed("NOT_FOUND");
    return observed("UNKNOWN");
  }

  async getAppointmentOutcome(): Promise<AppointmentOutcome> {
    // DTM has no appointment book; booking stays manual.
    throw new UnsupportedOperationError("appointment.status.read");
  }

  /**
   * One signed request. Throws SafeRetryable only when nothing was sent,
   * Ambiguous for any failure after sending began.
   */
  private async send(
    method: "GET" | "POST",
    pathWithQuery: string,
    body: string,
    idempotencyKey?: string,
  ): Promise<DtmResponse> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...signRequest({
        keyId: this.options.keyId,
        secret: this.options.secret,
        method,
        pathWithQuery,
        body,
        now: this.now(),
      }),
    };
    if (method === "POST") headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.options.baseUrl}${pathWithQuery}`,
        {
          method,
          headers,
          ...(method === "POST" ? { body } : {}),
          // A signed request is never replayed to another address.
          redirect: "manual",
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
    } catch (error) {
      if (notSent(error))
        throw new SafeRetryableConnectorError(
          "DTM unreachable before send",
          "DTM_UNREACHABLE",
        );
      throw new AmbiguousConnectorError(
        "DTM request failed after send",
        isTimeout(error) ? "DTM_TIMEOUT" : "DTM_CONNECTION_LOST",
      );
    }
    let text: string | null;
    try {
      text = await readBounded(response, MAX_RESPONSE_BYTES);
    } catch {
      throw new AmbiguousConnectorError(
        "DTM response was cut off",
        "DTM_RESPONSE_INCOMPLETE",
      );
    }
    return { status: response.status, json: parseObject(text) };
  }
}

/** Map DTM's answer to a delivery; docs/connectors/dtm.md lists each case. */
function deliveryResult(id: string, response: DtmResponse): ConnectorResult {
  const { status, json } = response;
  if (status === 200 || status === 201) {
    if (
      json?.schema_version === RECEIPT_SCHEMA_VERSION &&
      sameId(json.execution_id, id) &&
      isReference(json.reference) &&
      isInboxStatus(json.status)
    )
      return result(id, { status: "SUCCEEDED", external_id: json.reference });
    // Stored or not, the answer cannot be trusted: read it back.
    return result(id, { status: "AMBIGUOUS", unknown: "DTM_INVALID_RECEIPT" });
  }
  const error = typeof json?.error === "string" ? json.error : null;
  // Something is stored under this execution_id with other content: an
  // earlier send of ours. Read-back settles it.
  if (status === 409 && error === "idempotency_conflict")
    return result(id, {
      status: "AMBIGUOUS",
      unknown: "DTM_IDEMPOTENCY_CONFLICT",
    });
  if (status === 503 && error === "integration_disabled")
    return result(id, {
      status: "PERMANENT",
      code: "DTM_INTEGRATION_DISABLED",
    });
  // Refused before processing: DTM stored nothing and the same execution
  // may be sent again (DTM de-duplicates it in any case).
  if (status === 408 || status === 429 || status === 503)
    return result(id, { status: "RETRYABLE", code: `DTM_HTTP_${status}` });
  if (status >= 300 && status < 500)
    return result(id, {
      status: "PERMANENT",
      code:
        error && /^[a-z_]{1,64}$/.test(error)
          ? `DTM_${error.toUpperCase()}`
          : `DTM_HTTP_${status}`,
    });
  // 5xx and anything else: the delivery may have been stored.
  return result(id, { status: "AMBIGUOUS", unknown: `DTM_HTTP_${status}` });
}

function result(id: string, extra: Record<string, unknown>): ConnectorResult {
  return {
    schema_version: "connector-result.v1",
    execution_id: id,
    ...extra,
  } as ConnectorResult;
}

function sameId(value: unknown, id: string): boolean {
  return typeof value === "string" && value.toLowerCase() === id.toLowerCase();
}
function isReference(value: unknown): value is string {
  return typeof value === "string" && INBOX_REFERENCE.test(value);
}
function isInboxStatus(value: unknown): value is InboxStatus {
  return INBOX_STATUSES.includes(value as InboxStatus);
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The body as text, or null when it is larger than `limit` bytes. */
async function readBounded(
  response: Response,
  limit: number,
): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorCodes(error: unknown): string[] {
  const codes: string[] = [];
  const visit = (e: unknown, depth: number) => {
    if (!e || typeof e !== "object" || depth > 3) return;
    const { code, cause, errors } = e as {
      code?: unknown;
      cause?: unknown;
      errors?: unknown;
    };
    if (typeof code === "string") codes.push(code);
    visit(cause, depth + 1);
    if (Array.isArray(errors))
      for (const inner of errors) visit(inner, depth + 1);
  };
  visit(error, 0);
  return codes;
}
/** True only if every underlying failure happened before sending. */
function notSent(error: unknown): boolean {
  if (isTimeout(error)) return false;
  const codes = errorCodes(error);
  return codes.length > 0 && codes.every((c) => NOT_SENT_CODES.has(c));
}
function isTimeout(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  return name === "TimeoutError" || name === "AbortError";
}
function codeOf(error: unknown): string {
  return error instanceof SafeRetryableConnectorError ||
    error instanceof AmbiguousConnectorError
    ? error.code.replace(/^DTM_/, "")
    : "ERROR";
}
