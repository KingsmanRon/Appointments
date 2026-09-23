const sensitive = new Set([
  "given_name",
  "family_name",
  "date_of_birth",
  "content_base64",
  "authorization",
]);
function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        sensitive.has(k.toLowerCase()) ? "[REDACTED]" : redact(v),
      ]),
    );
  return value;
}
export function log(
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {},
): void {
  process.stdout.write(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(redact(fields) as object),
    }) + "\n",
  );
}
export class Metrics {
  private values = new Map<string, number>();
  inc(name: string): void {
    this.values.set(name, (this.values.get(name) ?? 0) + 1);
  }
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.values);
  }
}
