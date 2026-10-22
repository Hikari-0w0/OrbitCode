export type VerificationStatus =
  | "verified"
  | "observed"
  | "partial"
  | "unverified"
  | "blocked";

export type CompletionCheck = {
  readonly scope?: "external-call";
  readonly criterion: string;
  readonly status: "passed" | "failed" | "not-run";
  readonly evidenceCallIds: readonly string[];
};

export type CompletionAssessment = {
  readonly status: VerificationStatus;
  readonly checks: readonly CompletionCheck[];
  readonly blockers: readonly string[];
};

export function unverifiedCompletionAssessment(): CompletionAssessment {
  return { status: "unverified", checks: [], blockers: [] };
}

export function isCompletionAssessment(value: unknown): value is CompletionAssessment {
  if (!isRecord(value) || !hasExactFields(value, ["status", "checks", "blockers"])) {
    return false;
  }
  if (!["verified", "observed", "partial", "unverified", "blocked"].includes(String(value.status))) {
    return false;
  }
  if (
    !Array.isArray(value.checks) ||
    value.checks.length > 20 ||
    !value.checks.every((check) =>
      isRecord(check) &&
      hasExactFields(check, check.scope === undefined ? ["criterion", "status", "evidenceCallIds"] : ["criterion", "status", "evidenceCallIds", "scope"]) &&
      (check.scope === undefined || check.scope === "external-call") &&
      typeof check.criterion === "string" &&
      check.criterion.length > 0 &&
      check.criterion.length <= 200 &&
      ["passed", "failed", "not-run"].includes(String(check.status)) &&
      Array.isArray(check.evidenceCallIds) &&
      check.evidenceCallIds.length <= 16 &&
      check.evidenceCallIds.every((id) =>
        typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(id)
      )
    )
  ) return false;
  return Array.isArray(value.blockers) &&
    value.blockers.length <= 10 &&
    value.blockers.every((blocker) =>
      typeof blocker === "string" && blocker.length > 0 && blocker.length <= 300
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): boolean {
  return Object.keys(value).length === fields.length &&
    fields.every((field) => field in value);
}
