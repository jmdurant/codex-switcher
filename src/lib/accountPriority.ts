import type { AccountWithUsage, UsageInfo } from "../types";

export type AccountClass = "team_10x" | "team" | "quorum" | "other";

/** Map the plan values currently returned by ChatGPT to user-facing tiers. */
export function classifyAccount(planType: string | null | undefined): AccountClass {
  const normalized = planType?.trim().toLowerCase() ?? "";
  if (normalized === "self_serve_business_prolite") return "team_10x";
  if (normalized === "team") return "team";
  if (normalized === "quorum") return "quorum";
  return "other";
}

export function accountClassLabel(accountClass: AccountClass): string {
  switch (accountClass) {
    case "team_10x": return "10x Team";
    case "team": return "Team";
    case "quorum": return "Quorum / Plus";
    default: return "Other";
  }
}

function full(value: number | null | undefined): boolean {
  return value !== null && value !== undefined && value >= 99.5;
}

export function isUsageExhausted(usage: UsageInfo | undefined): boolean {
  if (!usage || usage.error) return false;
  return usage.has_credits === false || full(usage.primary_used_percent) || full(usage.secondary_used_percent);
}

function remaining(usage: UsageInfo | undefined): number {
  if (!usage || usage.error) return -1;
  const values = [usage.primary_used_percent, usage.secondary_used_percent]
    .filter((value): value is number => typeof value === "number")
    .map((value) => 100 - value);
  return values.length ? Math.max(...values) : -1;
}

const CLASS_PRIORITY: Record<AccountClass, number> = {
  team_10x: 0,
  team: 1,
  quorum: 2,
  other: 3,
};

/** Select the best live, non-active fallback in the requested tier order. */
export function selectFallbackAccount(
  accounts: AccountWithUsage[],
  activeAccountId: string | undefined,
): AccountWithUsage | undefined {
  return accounts
    .filter((account) =>
      account.id !== activeAccountId &&
      !account.usageLoading &&
      account.usage !== undefined &&
      !account.usage.error &&
      !isUsageExhausted(account.usage)
    )
    .sort((left, right) => {
      const classDifference =
        CLASS_PRIORITY[classifyAccount(right.plan_type)] - CLASS_PRIORITY[classifyAccount(left.plan_type)];
      if (classDifference !== 0) return -classDifference;
      return remaining(right.usage) - remaining(left.usage);
    })[0];
}

