import { createAdminClient } from "@/lib/supabase/admin";
import { nyDay } from "@/lib/google-usage-core";
import { workspaceMcpMode } from "@/lib/workspace-mcp-core";

// Settings › Calls & usage: Google Workspace requests by API over the last 14 days, split into our own REST calls and
// calls through Google's Workspace MCP servers, against Google's Standard tier (free; Google's MCP servers capped at
// 5,000 requests a day per product per project). Counted by the server as it goes (lib/google-usage), so a close floor.

const MCP_DAILY_CAP = 5_000;
const LABEL: Record<string, string> = {
  gmail: "Gmail",
  drive: "Drive",
  calendar: "Calendar",
  docs: "Docs",
  sheets: "Sheets",
  slides: "Slides",
  directory: "Directory",
  chat: "Chat",
  people: "People",
};

type Row = {
  day: string;
  api: string;
  via: "rest" | "mcp";
  requests: number;
  errors: number;
};

export async function WorkspaceUsage() {
  const { since, today } = usageWindow();
  const { data } = await createAdminClient().from("google_api_usage").select("day, api, via, requests, errors").gte("day", since).order("day");
  const rows = (data ?? []) as Row[];
  const apis = [...new Set(rows.map((r) => r.api))].sort((a, b) => sum(rows, b) - sum(rows, a));
  const mode = workspaceMcpMode();
  const days = new Set(rows.map((r) => r.day)).size || 1;

  return (
    <section className="rounded-[28px] border border-line bg-deep px-5 py-5 md:px-8 md:py-7">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Google Workspace requests · last 14 days</p>
          <p className="mt-1 text-sm text-muted">
            Agents reach Gmail and Drive {mode === "off" ? "by REST (MCP switched off)" : mode === "only" ? "only through Google's MCP servers" : "through Google's MCP servers, REST as fallback"}.
            Standard tier: free, MCP capped at {MCP_DAILY_CAP.toLocaleString()} a day per product.
          </p>
        </div>
      </div>
      {!rows.length ? (
        <p className="mt-5 text-sm text-muted">Nothing counted yet. Counting started Nov 24, 2026; the first numbers show after the next sync.</p>
      ) : (
        <ul className="mt-5 grid gap-2">
          {apis.map((api) => {
            const mine = rows.filter((r) => r.api === api);
            const todayRest = mine.filter((r) => r.day === today && r.via === "rest").reduce((t, r) => t + r.requests, 0);
            const todayMcp = mine.filter((r) => r.day === today && r.via === "mcp").reduce((t, r) => t + r.requests, 0);
            const peakMcp = Math.max(0, ...[...new Set(mine.map((r) => r.day))].map((d) => mine.filter((r) => r.day === d && r.via === "mcp").reduce((t, r) => t + r.requests, 0)));
            const total = sum(mine);
            const errors = mine.reduce((t, r) => t + r.errors, 0);
            const share = Math.min(1, peakMcp / MCP_DAILY_CAP);
            return (
              <li key={api} className="grid gap-1.5 rounded-2xl border border-line bg-bg/40 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="font-medium text-fg">{LABEL[api] ?? api}</span>
                  <span className="tabular text-[13px] text-muted">
                    <span className="text-fg">{Math.round(total / days).toLocaleString()}</span> a day · today {todayRest.toLocaleString()} REST, {todayMcp.toLocaleString()} MCP
                    {errors > 0 && <span className="text-bad"> · {errors.toLocaleString()} failed</span>}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line" aria-hidden>
                    <span
                      className={`block h-full rounded-full ${share > 0.8 ? "bg-bad" : share > 0.5 ? "bg-warn" : "bg-brand"}`}
                      style={{
                        width: `${Math.max(share * 100, peakMcp ? 2 : 0)}%`,
                      }}
                    />
                  </span>
                  <span className="tabular shrink-0 text-[12px] text-faint">
                    busiest MCP day {peakMcp.toLocaleString()} / {MCP_DAILY_CAP.toLocaleString()}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const sum = (rows: Row[], api?: string) => rows.filter((r) => !api || r.api === api).reduce((t, r) => t + r.requests, 0);

/** The 14 New York days shown, ending today */
function usageWindow() {
  const now = Date.now();
  return { since: nyDay(now - 13 * 86_400_000), today: nyDay(now) };
}
