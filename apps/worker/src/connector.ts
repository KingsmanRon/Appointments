import type { ConnectorResult } from "@access/contracts";
export type FaultMode =
  | "success"
  | "retryable"
  | "permanent"
  | "deferred"
  | "committed-timeout"
  | "malformed"
  | "capability-withdrawn";
export interface Connector {
  execute(command: {
    execution_id: string;
    referral_id: string;
  }): Promise<ConnectorResult>;
  reconcile(executionId: string): Promise<ConnectorResult>;
}
export class MockConnector implements Connector {
  private committed = new Map<string, string>();
  constructor(private fault: FaultMode = "success") {}
  async execute(c: {
    execution_id: string;
    referral_id: string;
  }): Promise<ConnectorResult> {
    if (this.committed.has(c.execution_id))
      return {
        schema_version: "connector-result.v1",
        execution_id: c.execution_id,
        status: "SUCCEEDED",
        external_id: this.committed.get(c.execution_id)!,
      };
    if (this.fault === "retryable")
      return {
        schema_version: "connector-result.v1",
        execution_id: c.execution_id,
        status: "RETRYABLE",
        code: "TEMPORARY",
      };
    if (this.fault === "permanent" || this.fault === "capability-withdrawn")
      return {
        schema_version: "connector-result.v1",
        execution_id: c.execution_id,
        status: "PERMANENT",
        code: this.fault === "permanent" ? "REJECTED" : "CAPABILITY_WITHDRAWN",
      };
    if (this.fault === "deferred")
      return {
        schema_version: "connector-result.v1",
        execution_id: c.execution_id,
        status: "DEFERRED",
        descriptor: "manual connector approval",
      };
    if (this.fault === "malformed")
      throw new Error("connector schema violation");
    const external = `MOCK-${c.referral_id.slice(0, 8)}`;
    this.committed.set(c.execution_id, external);
    if (this.fault === "committed-timeout")
      return {
        schema_version: "connector-result.v1",
        execution_id: c.execution_id,
        status: "AMBIGUOUS",
        unknown: "timeout after request body accepted",
      };
    return {
      schema_version: "connector-result.v1",
      execution_id: c.execution_id,
      status: "SUCCEEDED",
      external_id: external,
    };
  }
  async reconcile(id: string): Promise<ConnectorResult> {
    const external = this.committed.get(id);
    return external
      ? {
          schema_version: "connector-result.v1",
          execution_id: id,
          status: "SUCCEEDED",
          external_id: external,
        }
      : {
          schema_version: "connector-result.v1",
          execution_id: id,
          status: "AMBIGUOUS",
          unknown: "no uniquely matching result",
        };
  }
}
