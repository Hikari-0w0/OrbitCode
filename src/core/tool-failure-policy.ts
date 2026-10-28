export type ToolFailurePolicy = "strict" | "exact" | "warn";

export function isToolFailurePolicy(value: unknown): value is ToolFailurePolicy {
  return value === "strict" || value === "exact" || value === "warn";
}
