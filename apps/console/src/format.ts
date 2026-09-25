export const STATE_LABELS: Record<string, string> = {
  RECEIVED: "Received",
  IDENTITY_PENDING: "Identity pending",
  INFORMATION_MISSING: "Information missing",
  READY: "Ready (destination entry)",
  DESTINATION_PENDING: "Sending to destination",
  READY_FOR_BOOKING: "Ready for booking",
  WAITING: "Waiting",
  BOOKED: "Booked",
  CLOSED: "Closed",
  EXCEPTION: "Exception",
  REJECTED: "Rejected",
};
export const RESOLUTION_LABELS: Record<string, string> = {
  BOOKED: "Booked",
  PATIENT_UNREACHABLE: "Patient unreachable",
  PATIENT_DECLINED: "Patient declined",
  PROVIDER_DECLINED: "Provider declined",
  DUPLICATE_REFERRAL: "Duplicate referral",
  INVALID_REFERRAL: "Invalid referral",
  MISSING_INFORMATION: "Information never supplied",
  REFERRED_ELSEWHERE: "Referred elsewhere",
  CANCELLED: "Cancelled",
  UNKNOWN: "Unknown outcome",
};
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "Unknown";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} d`;
}
export function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}
export function percent(value: number | null | undefined): string {
  return value === null || value === undefined
    ? "Unknown"
    : `${(value * 100).toFixed(1)}%`;
}
export function stateClass(state: string): string {
  return `badge state-${state.toLowerCase().replace(/_/g, "-")}`;
}
export function label(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}
