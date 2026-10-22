export type TokenBudgetSnapshot = {
  readonly limit: number;
  readonly reported: number;
  readonly reserved: number;
  readonly unknown: number;
  readonly available: number;
  readonly overdrawn: boolean;
  readonly estimation: "utf8-json-plus-framing";
};

// 未报告用量的尝试保留预留额；预估只是本地接纳策略，不能作为厂商计费保证。
export class TokenReservationBudget {
  private reported = 0;
  private reserved = 0;
  private unknown = 0;
  constructor(readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("token预算必须是正整数。");
  }
  reserve(tokens: number): { settle(reported?: number): void } | undefined {
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw new Error("token预留必须是正整数。");
    if (tokens > this.snapshot().available) return undefined;
    this.reserved += tokens;
    let settled = false;
    return { settle: usage => {
      if (settled) return;
      settled = true;
      this.reserved -= tokens;
      if (usage !== undefined && Number.isSafeInteger(usage) && usage >= 0) this.reported += usage;
      else this.unknown += tokens;
    } };
  }
  snapshot(): TokenBudgetSnapshot {
    const spent = this.reported + this.reserved + this.unknown;
    return { limit: this.limit, reported: this.reported, reserved: this.reserved, unknown: this.unknown,
      available: Math.max(0, this.limit - spent), overdrawn: spent > this.limit, estimation: "utf8-json-plus-framing" };
  }
}
