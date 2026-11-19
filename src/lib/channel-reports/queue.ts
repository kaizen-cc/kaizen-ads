import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LIVE } from "@/lib/live";
import { servicesOf } from "@/lib/services";
import { onService } from "@/lib/service-gate";
import { reportListeners } from "@/lib/reports/access";
import { channelPeriods, LINE_SERVICE, platformOfLine, type ChannelKind, type ChannelLine } from "./core";
import { coverageFor, ownersFor } from "./clients";
import { hasNumbers } from "./data";
import { draftChannelReport } from "./write";
import { historyHolds } from "@/lib/email-history/core";
import { requestHistory, runHistory } from "@/lib/email-history/run";
import { loadPauses } from "@/lib/account-watch/pauses";

// The channel reports' cadence, the same as the ads reports: every Monday a weekly for every connected client, except the
// month's first Monday, which gets the monthly (the month just over) instead. Queued reports are drafted a few
// at a time by the same schedule that drafts the ads reports, and a failure here never reaches them. Safe to run again:
// a client's report for a period is made once. Clients that aren't connected are never drafted empty; the Reports page
// lists them with what to connect.

type Result = { created: number; skipped: { client: string; reason: string }[]; error?: string };

/** Queues this period's reports that don't exist yet (one client's or one line's, with the options) */
export async function queueChannelReports(admin: SupabaseClient, kind: ChannelKind, today: string, opts: { onlyClient?: string; lines?: ChannelLine[] } = {}): Promise<Result> {
  const out: Result = { created: 0, skipped: [] };
  const p = channelPeriods(kind, today).main;
  const { data: clients } = await admin.from("clients").select("id, name, services, services_extra, services_removed, strategy_only").is("archived_at", null).eq("internal", false).in("status", [...LIVE]);
  const all = ((clients ?? []) as { id: string; name: string; services: string[] | null; services_extra: string[] | null; services_removed: string[] | null }[]).filter((c) => !opts.onlyClient || c.id === opts.onlyClient);
  for (const line of opts.lines ?? (["email", "social"] as ChannelLine[])) {
    // Every connected client that buys the line gets both, like the ads reports (weekly Mondays, monthly the first Monday)
    const buying = all.filter((c) => servicesOf(c).includes(LINE_SERVICE[line] as never));
    if (!buying.length) continue;
    // A service a lead paused until a date is left out until then (nothing is deleted)
    const paused = await loadPauses(admin, LINE_SERVICE[line], today);
    const cover = await coverageFor(admin, line, buying.map((c) => c.id));
    const owners = await ownersFor(admin, line, buying.map((c) => c.id));
    const platform = platformOfLine(line);
    for (const c of buying) {
      const cv = cover.get(c.id);
      if (paused.has(c.id)) {
        out.skipped.push({ client: c.name, reason: `Paused until ${paused.get(c.id)!.until}` });
        continue;
      }
      if (cv?.state !== "connected") {
        out.skipped.push({ client: c.name, reason: cv?.what ?? "Not connected" });
        continue;
      }
      // One report per client, line, kind and period (a skipped one stays skipped)
      const { data: had, error: readError } = await admin.from("reports").select("id").eq("client_id", c.id).eq("platform", platform).eq("kind", kind).eq("period_start", p.start).is("target_id", null).maybeSingle();
      if (readError) return { ...out, error: "The channel reports migration hasn't been applied yet." };
      if (had) continue;
      // Never drafted empty: the client has numbers in the last 120 days
      const since = new Date(Date.parse(`${today}T12:00:00Z`) - 120 * 86_400_000).toISOString().slice(0, 10);
      if (!(await hasNumbers(admin, line, c.id, since))) {
        out.skipped.push({ client: c.name, reason: "Connected, but no numbers have been read yet" });
        continue;
      }
      const { error } = await admin.from("reports").insert({ client_id: c.id, target_id: null, platform, kind, period_start: p.start, period_end: p.end, owner_id: owners.get(c.id) ?? null, status: "queued" });
      // A twin made by another run a moment ago is fine; anything else stops the line
      if (error && error.code !== "23505") return { ...out, error: error.message };
      if (!error) out.created++;
    }
  }
  return out;
}

/** Drafts queued channel reports, a few at a time (each is a writer and a QA pass), until the time runs out */
export async function draftChannelQueued(admin: SupabaseClient, budgetMs = 240_000) {
  const until = Date.now() + budgetMs;
  let done = 0;
  const held = new Set<string>();
  const kick = new Set<string>();
  while (Date.now() < until - 120_000) {
    // Queued ones, and any stuck mid-draft for 20 minutes (a timeout)
    const stuck = new Date(Date.now() - 20 * 60_000).toISOString();
    let q = admin.from("reports").select("id, status, updated_at, client_id, platform, period_start, clients(services, services_extra, services_removed, strategy_only)").in("platform", ["klaviyo", "social"]).or(`status.eq.queued,and(status.eq.drafting,updated_at.lt.${stuck})`).order("kind", { ascending: true }).order("created_at").limit(3);
    if (held.size) q = q.not("id", "in", `(${[...held].join(",")})`);
    const { data } = await q;
    if (!data?.length) break;
    // Each one claimed before it's written, so the schedule and a page never write one twice
    const claimed: string[] = [];
    for (const r of data) {
      // A line the client no longer buys (src/lib/service-gate.ts): the report waits, kept, until the service is back
      if (!onService({ platform: r.platform === "klaviyo" ? "email" : "social", clients: r.clients ?? null })) {
        held.add(r.id as string);
        continue;
      }
      // An email report asking for dates before the stored history waits while the missing months are read (queued once)
      if (r.platform === "klaviyo") {
        const ask = await requestHistory(admin, r.client_id as string, { wantStart: r.period_start as string, asked: "report" }).catch(() => null);
        if (ask?.queued) kick.add(r.client_id as string);
        if (ask?.state && historyHolds(ask.state, r.period_start as string)) {
          held.add(r.id as string);
          continue;
        }
      }
      const { data: got } = await admin.from("reports").update({ status: "drafting", updated_at: new Date().toISOString() }).eq("id", r.id).eq("status", r.status).eq("updated_at", r.updated_at).select("id").maybeSingle();
      if (got) claimed.push(r.id as string);
    }
    await Promise.all(claimed.map((id) => draftChannelReport(admin, id)));
    done += claimed.length;
  }
  // The missing months, read now with the time that is left (what does not finish goes on from the schedule); the held reports are written when it lands
  for (const id of kick) {
    const left = until - Date.now();
    if (left > 75_000) await runHistory(admin, id, left - 15_000).catch(() => null);
  }
  return done;
}

/** A nudge to the owner of a channel report nobody has sent, on the ads reports' schedule (Monday afternoon, Tuesday morning): a monthly by the 5th */
export async function remindChannelReports(admin: SupabaseClient, today: string) {
  const { data } = await admin.from("reports").select("id, kind, platform, owner_id, client_id, period_start, clients(name, services, services_extra, services_removed, strategy_only)").in("platform", ["klaviyo", "social"]).in("status", ["draft", "failed"]).not("owner_id", "is", null).gte("period_start", new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10));
  // Only the lines the client buys (src/lib/service-gate.ts)
  const rows = (data ?? []).filter((r) => onService({ platform: r.platform === "klaviyo" ? "email" : "social", clients: r.clients ?? null })) as unknown as { id: string; kind: string; owner_id: string; client_id: string; clients: { name: string } }[];
  const day = Number(today.slice(8, 10));
  const told = await reportListeners(admin, rows.map((r) => r.owner_id));
  let n = 0;
  for (const r of rows) {
    if (!told.has(r.owner_id)) continue;
    const monthly = r.kind === "monthly";
    if (monthly && day > 5) continue;
    await admin.from("notifications").upsert(
      {
        profile_id: r.owner_id,
        kind: "report",
        title: monthly ? `${r.clients.name}: the monthly report is due by the 5th` : `${r.clients.name}: this week's report hasn't gone out`,
        // A month's report is saved to the client's Drive with its write-up (like the ads monthly); a week's goes to the client
        body: monthly ? "It's drafted and checked: read it over and save it to the client's Drive." : "It's drafted and checked: read it over and send it.",
        href: `/reports/${r.id}`,
        client_id: r.client_id,
        key: `report-remind:${r.id}:${today}`,
        priority: monthly && day >= 4 ? "critical" : "normal",
      },
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );
    n++;
  }
  return n;
}

/** Drafts a channel report on demand for a client and period (a month or a week just over, dates picked in the builder, or the one after a sent report): the existing one is opened instead of a second */
export async function draftChannelNow(admin: SupabaseClient, p: { clientId: string; line: ChannelLine; kind: ChannelKind; period: { start: string; end: string }; ownerId: string | null }): Promise<{ ok: true; id: string; existing: boolean } | { ok: false; error: string }> {
  const platform = platformOfLine(p.line);
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (p.period.end > yesterday) return { ok: false, error: "That period isn't over yet: the data runs through yesterday." };
  const { data: had } = await admin.from("reports").select("id, status, period_end").eq("client_id", p.clientId).eq("platform", platform).eq("kind", p.kind).eq("period_start", p.period.start).is("target_id", null).maybeSingle();
  // Dates picked by hand that start the same day but end on another: the same report, moved to the new dates and written again
  const moved = had && p.kind === "custom" && had.period_end !== p.period.end;
  if (moved && had.status === "posted") return { ok: false, error: "A report starting that day already went to this client. Pick different dates." };
  if (had && had.status !== "skipped" && !moved) return { ok: true, id: had.id as string, existing: true };
  if (had) {
    await admin.from("reports").update({ status: "queued", error: null, period_end: p.period.end, hidden_at: null, updated_at: new Date().toISOString() }).eq("id", had.id);
    return { ok: true, id: had.id as string, existing: false };
  }
  const { data, error } = await admin.from("reports").insert({ client_id: p.clientId, target_id: null, platform, kind: p.kind, period_start: p.period.start, period_end: p.period.end, owner_id: p.ownerId, status: "queued" }).select("id").single();
  if (error || !data) return { ok: false, error: error?.message ?? "Couldn't start it." };
  return { ok: true, id: data.id as string, existing: false };
}
