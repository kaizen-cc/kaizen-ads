import Link from "next/link";
import { klaviyoRoster } from "@/lib/klaviyo/store";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";

// Settings › Connections › Media keys: Klaviyo for every live client, connected or missing, with a Connect link to the
// client's Team & setup (where a lead or exec pastes that account's read-only private API key). Keys are never shown.

const ago = (iso: string) => {
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1 ? "read in the last hour" : h < 48 ? `read ${h}h ago` : `read ${Math.round(h / 24)}d ago`;
};

export async function KlaviyoCard() {
  const roster = adminConfigured() ? await klaviyoRoster(createAdminClient()).catch(() => null) : null;
  const connected = roster?.filter((r) => r.status !== "missing").length ?? 0;
  const failing = roster?.filter((r) => r.status === "failing").length ?? 0;
  const order = { failing: 0, missing: 1, connected: 2 } as const;
  const rows = [...(roster ?? [])].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const dot = { connected: "bg-ok", failing: "bg-bad", missing: "bg-faint" } as const;

  return (
    <section className="grid content-start gap-4 rounded-[16px] border border-line bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="font-heading text-[18px] leading-tight">Klaviyo</h2>
          <p className="max-w-2xl text-xs leading-relaxed text-muted">
            Each client&apos;s email and SMS, read only, synced daily as context for their accounts. One read-only private API key per Klaviyo account, pasted in the client&apos;s Team &amp; setup (Read Access to Accounts, Campaigns, Flows, Lists, Segments and Metrics). Keys are encrypted and never shown here.
          </p>
        </div>
        {roster && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted">
            <span className={`h-2 w-2 rounded-full ${failing ? "bg-bad" : connected ? "bg-ok" : "bg-faint"}`} aria-hidden />
            {connected} of {roster.length} connected{failing ? ` · ${failing} failing` : ""}
          </span>
        )}
      </div>
      {!roster ? (
        <p className="text-sm text-faint">Klaviyo isn&apos;t set up in the database yet: its migration hasn&apos;t been applied.</p>
      ) : (
        <ul className="grid gap-1.5 md:grid-cols-2">
          {rows.map((r) => (
            <li key={r.id} className="flex min-h-11 items-center gap-3 rounded-[12px] border border-line px-3 py-2 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${dot[r.status]}`} aria-hidden />
              <span className="grid min-w-0 flex-1">
                <span className="truncate">{r.name}</span>
                <span className={`truncate text-[11.5px] ${r.status === "failing" ? "text-bad" : "text-faint"}`}>
                  {r.status === "missing" ? "Not connected" : r.status === "failing" ? (r.error ?? "Failing") : `${r.account ?? "Connected"}${r.lastSyncedAt ? ` · ${ago(r.lastSyncedAt)}` : " · first read pending"}`}
                </span>
              </span>
              <Link href={`/clients/${r.slug}?tab=team#klaviyo`} className="shrink-0 rounded-full border border-line px-3 py-1.5 text-[12.5px] text-muted hover:text-fg">
                {r.status === "missing" ? "Connect" : r.status === "failing" ? "Fix" : "Open"}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
