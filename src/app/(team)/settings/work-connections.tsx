import type { ConnRow } from "@/lib/personal-connections";
import { connectHref, SERVICE_NAME, type ConnState } from "@/lib/personal-connections-core";

// Settings › Connections › Yours, first: the accounts your assistant works in as you. Slack and Asana are yours to
// connect (your own sign-ins); Gmail, Drive and Calendar go through Kaizen's Google Workspace, so there's nothing to
// connect, and anything off there is an admin setting. "Should my Slack be under Team connectors?" No: it's here.

const TONE: Record<ConnState, { dot: string; label: string }> = {
  connected: { dot: "bg-ok", label: "Connected" },
  missing: { dot: "bg-faint", label: "Not connected" },
  reconnect: { dot: "bg-bad", label: "Needs reconnect" },
  missing_scope: { dot: "bg-warn", label: "Posting only, reading off" },
  admin: { dot: "bg-warn", label: "Admin setting" },
  off: { dot: "bg-faint", label: "Not set up" },
};

export function WorkConnections({ rows, flash }: { rows: ConnRow[]; flash?: string | null }) {
  const back = "/settings?tab=connections&section=yours";
  return (
    <section className="grid gap-3" aria-labelledby="work-accounts">
      <div className="grid gap-1">
        <h2 id="work-accounts" className="font-heading text-[18px] leading-tight">
          Your work accounts
        </h2>
        <p className="text-xs leading-relaxed text-muted">What your assistant reads and writes as you. These are yours alone, not the team&apos;s connectors.</p>
      </div>
      {flash && (
        <p role="status" className="rounded-[12px] border border-line bg-surface-2/50 px-3 py-2 text-[13px] text-fg">
          {flash}
        </p>
      )}
      <ul className="grid gap-2">
        {rows.map((r) => {
          const tone = TONE[r.state];
          const link = (r.service === "slack" || r.service === "asana") && (r.state === "missing" || r.state === "reconnect" || r.state === "missing_scope") ? connectHref(r.service, back) : null;
          return (
            <li key={r.service} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line bg-surface p-3 md:p-4">
              <div className="grid min-w-0 flex-1 gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14.5px] font-medium text-fg">{SERVICE_NAME[r.service]}</span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-muted">
                    <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden />
                    {tone.label}
                  </span>
                </div>
                <p className="text-[12.5px] leading-snug text-muted [overflow-wrap:anywhere]">{r.detail}</p>
                {r.scopes && r.scopes.some((s) => !s.ok) && (
                  <p className="text-[11.5px] text-faint">
                    {r.scopes.map((s) => `${s.scope} ${s.ok ? "on" : "off"}`).join(" · ")}
                  </p>
                )}
              </div>
              {link && (
                <a href={link} className="inline-flex min-h-11 shrink-0 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg transition hover:opacity-90 md:min-h-9">
                  {r.state === "missing" ? "Connect" : "Reconnect"}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
