import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { lineName, type ChannelLine } from "@/lib/channel-reports/core";
import { coverageFor, type ChannelClient } from "@/lib/channel-reports/clients";
import { ChannelClientRow } from "./channel-client-row";
import { Empty } from "./report-cards";

// The Build a report view for Email and Social: the same place as the ads builder, listing this person's clients on the
// line. Connected ones can draft a report now (the weekly and monthly also come on their own); the others say what to connect.

type Rep = { id: string; client_id: string; kind: string; status: string; period_start: string; period_end: string };

const short = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const periodOf = (r: Rep) => (r.kind === "monthly" ? new Date(`${r.period_start}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : `${short(r.period_start)} – ${short(r.period_end)}`);

export async function ChannelBuild({ line, clients, rows }: { line: ChannelLine; clients: ChannelClient[]; rows: Rep[] }) {
  const admin = adminConfigured() ? createAdminClient() : null;
  const ids = clients.map((c) => c.id);
  const [cover, prefs] =
    admin && ids.length
      ? await Promise.all([
          coverageFor(admin, line, ids),
          // The column may not exist yet: no one has a weekly then
          admin.from("client_report_prefs").select("client_id, channel_weekly").in("client_id", ids).then((x) => (x.error ? { data: [] as { client_id: string; channel_weekly: string[] | null }[] } : x)),
        ])
      : [new Map<string, { state: "connected" | "missing" | "pending" | "failing"; what: string | null }>(), { data: [] as { client_id: string; channel_weekly: string[] | null }[] }];
  const weekly = new Set((prefs.data ?? []).filter((p) => p.channel_weekly?.includes(line)).map((p) => p.client_id));
  const latestOf = (id: string) => {
    const r = rows.filter((x) => x.client_id === id && x.status !== "skipped").sort((a, b) => b.period_start.localeCompare(a.period_start))[0];
    return r ? { id: r.id, label: `${periodOf(r)} · ${r.status === "posted" ? "sent" : r.status === "draft" ? "ready to review" : r.status}`, status: r.status } : null;
  };
  const connected = clients.filter((c) => cover.get(c.id)?.state === "connected").length;

  if (!clients.length) return <Empty title="No clients yet" body={`You'll see the clients that buy ${line === "email" ? "Email Marketing" : "Social Media"} and have you seated here.`} />;
  return (
    <section className="grid gap-4">
      <div className="grid gap-1">
        <h3 className="font-heading text-[19px]">{lineName(line)} report, any client</h3>
        <p className="text-sm text-muted">
          {connected} of {clients.length} connected. Like the ads reports, a weekly is drafted every Monday and the monthly on the month&apos;s first Monday; draft last month or last week now. The ones not connected say what to connect.
        </p>
      </div>
      <ul className="grid gap-2.5">
        {[...clients]
          .sort((a, b) => Number(cover.get(a.id)?.state === "connected") - Number(cover.get(b.id)?.state === "connected") || a.name.localeCompare(b.name))
          .map((c) => (
            <ChannelClientRow key={c.id} clientId={c.id} name={c.name} slug={c.slug} line={line} state={cover.get(c.id)?.state ?? "missing"} what={cover.get(c.id)?.what ?? null} weekly={weekly.has(c.id)} latest={latestOf(c.id)} />
          ))}
      </ul>
    </section>
  );
}
