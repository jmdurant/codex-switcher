import type { AccountInfo, AccountWithUsage, UsageInfo } from "../types";

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

function displayRemaining(usage: UsageInfo | undefined): number | null {
  if (!usage || usage.error) return null;
  const used = usage.primary_used_percent ?? usage.secondary_used_percent;
  return typeof used === "number" && Number.isFinite(used)
    ? Math.max(0, Math.min(100, 100 - used))
    : null;
}

/** Shared ordering for the tray and the main account list. */
export function compareAccountAvailability(
  left: AccountInfo,
  right: AccountInfo,
  leftUsage?: UsageInfo,
  rightUsage?: UsageInfo,
): number {
  if (left.is_active !== right.is_active) return left.is_active ? -1 : 1;
  const leftRemaining = displayRemaining(leftUsage);
  const rightRemaining = displayRemaining(rightUsage);
  const leftAvailable = leftRemaining !== null && leftRemaining > 0 && !isUsageExhausted(leftUsage);
  const rightAvailable = rightRemaining !== null && rightRemaining > 0 && !isUsageExhausted(rightUsage);
  if (leftAvailable !== rightAvailable) return leftAvailable ? -1 : 1;

  const tierDifference = CLASS_PRIORITY[classifyAccount(left.plan_type)] - CLASS_PRIORITY[classifyAccount(right.plan_type)];
  if (tierDifference !== 0) return tierDifference;
  if (leftAvailable && rightAvailable) {
    const remainingDifference = rightRemaining - leftRemaining;
    if (remainingDifference !== 0) return remainingDifference;
    const resetAt = (usage: UsageInfo | undefined) => {
      const value = usage?.primary_used_percent != null ? usage.primary_resets_at : usage?.secondary_resets_at;
      return value != null && Number.isFinite(value) ? value : Number.MAX_VALUE;
    };
    const resetDifference = resetAt(leftUsage) - resetAt(rightUsage);
    if (resetDifference !== 0) return resetDifference;
  }
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

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
