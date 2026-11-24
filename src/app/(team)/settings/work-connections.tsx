import type { ConnRow } from "@/lib/personal-connections";
import { connectHref, SERVICE_NAME, type ConnState } from "@/lib/personal-connections-core";
import { AccountControls, AsanaWorkspaces } from "./work-connection-controls";

// Settings › Connections › Yours, first: the accounts your assistant works in as you. Slack and Asana are yours to
// connect (your own sign-ins); Gmail, Drive and Calendar go through Kaizen's Google Workspace, so there's nothing to
// connect, and anything off there is an admin setting. "Should my Slack be under Team connectors?" No: it's here.

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
};

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
          const link = (r.service === "slack" || r.service === "asana") && !r.own && (r.state === "missing" || r.state === "reconnect" || r.state === "missing_scope") ? connectHref(r.service, back) : null;
          const tone = r.pending ? { dot: "bg-warn", label: "Check the account" } : TONE[r.state];
          return (
            <li key={r.service} id={r.service} className="flex min-w-0 scroll-mt-24 flex-wrap items-center justify-between gap-3 rounded-[14px] border border-line bg-surface p-3 md:p-4">
              <div className="grid min-w-0 flex-1 gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[14.5px] font-medium text-fg">{SERVICE_NAME[r.service]}</span>
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-[11.5px] text-muted">
                    <span className={`h-2 w-2 rounded-full ${tone.dot}`} aria-hidden />
                    {tone.label}
                  </span>
                </div>
                {r.account && <p className="text-[13px] leading-snug text-fg [overflow-wrap:anywhere]">{r.pending ? "Signed in as" : "Connected as"} {r.account}</p>}
                <p className="text-[12.5px] leading-snug text-muted [overflow-wrap:anywhere]">{r.detail}</p>
                {r.lastSync && <p className="text-[11.5px] text-faint">Last sync {ago(r.lastSync)}</p>}
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
              {/* Their own sign-in: which account it is can be changed or removed right here */}
              {r.own && (r.service === "slack" || r.service === "asana") && <AccountControls service={r.service} back={back} pending={r.pending ?? null} reconnect={r.state === "missing_scope" || (r.state === "reconnect" && !r.pending) ? connectHref(r.service, back) : null} />}
              {r.service === "asana" && r.workspaces && r.workspaces.length > 1 && !r.pending && <AsanaWorkspaces spaces={r.workspaces} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
