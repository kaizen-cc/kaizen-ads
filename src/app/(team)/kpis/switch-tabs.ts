import type { Staff } from "@/lib/auth";
import type { BoardCounts } from "@/lib/kpi/board-counts";
import { platformLabel } from "@/lib/kpi/platform";
import { teamPlatform } from "@/lib/roles";
import type { BoardSwitch } from "./channel-board";

/** The page-to-page tabs of the KPI switch (the ad platforms, Email, Social, and Account review for execs), one active */
export function kpiSwitchTabs(me: Staff, counts: BoardCounts | null, active: "email" | "social" | "review"): BoardSwitch[] {
  const team = teamPlatform(me.role);
  const ads = (team === "google" ? ["google"] : team === "meta" ? ["meta", "tiktok"] : ["meta", "google", "tiktok"]).filter((p) => p !== "tiktok" || (counts?.tiktok ?? 0) > 0) as ("meta" | "google" | "tiktok")[];
  return [
    ...ads.map((p) => ({ id: p, label: platformLabel(p), count: counts?.[p] ?? null, href: `/kpis?p=${p}`, active: false })),
    { id: "email", label: "Email", count: counts?.email ?? null, href: "/kpis?p=email", active: active === "email" },
    { id: "social", label: "Social", count: counts?.social ?? null, href: "/kpis?p=social", active: active === "social" },
    ...(me.isExec ? [{ id: "review", label: "Account review", href: "/kpis?p=review", active: active === "review" }] : []),
  ];
}
