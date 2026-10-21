export type ParentExecutionMode = "collaborate" | "delegate-only";
export type DelegationKind = "defined" | "fork";
export type ParentExecutionContract = {
  readonly version: 1;
  readonly mode: ParentExecutionMode;
  readonly delegationKind?: DelegationKind;
};

export function isParentExecutionContract(value: unknown): value is ParentExecutionContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.keys(value).every(key => ["version", "mode", "delegationKind"].includes(key)) &&
    "version" in value && value.version === 1 &&
    "mode" in value && (value.mode === "collaborate" || value.mode === "delegate-only") &&
    (!("delegationKind" in value) || value.delegationKind === "defined" || value.delegationKind === "fork");
}
