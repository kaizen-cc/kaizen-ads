// How an audit's verdict looks, for the KPI card (client) and the audit page (server) alike.
export const VERDICT: Record<string, { label: string; tone: string; ring: string }> = {
  off: { label: "Off target", tone: "text-bad", ring: "border-bad/40 bg-bad-soft" },
  at_risk: { label: "At risk", tone: "text-warn", ring: "border-warn/40 bg-warn-soft" },
  on_track: { label: "On track", tone: "text-ok", ring: "border-ok/40 bg-ok-soft" },
  winning: { label: "Winning", tone: "text-ok", ring: "border-ok/40 bg-ok-soft" },
};
