import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nyParts } from "@/lib/kpi/calc";
import { LIVE } from "@/lib/live";
import { sendEmail } from "@/lib/email";
import { postAsUser } from "@/lib/slack-user";
import { renderReportPdf } from "./pdf";
import { periodsFor, type ReportMetrics } from "./metrics";
import { draftReport, type Sections } from "./write";

// The reporting cadence. Mondays: a weekly report is queued for every live account that spent in the last week, and
// drafted a few at a time. The 1st: the monthly recap, one part per buyer on the client (Meta, Google), held until
// every part is submitted, then sent to the client in Slack and by email with the live link and the PDF.

const SITE = () => process.env.NEXT_PUBLIC_SITE_URL || "https://ads.kaizenmarketing.agency";

type TargetRow = { id: string; client_id: string; platform: string; owner_id: string | null; clients: { status: string; archived_at: string | null } };

/** Live accounts with an owner and spend in the window (from the KPI snapshot). */
async function liveTargets(admin: SupabaseClient, window: "d7" | "d30") {
  const [{ data: targets }, { data: snaps }] = await Promise.all([
    admin.from("kpi_targets").select("id, client_id, platform, owner_id, ad_account_id, clients!inner(status, archived_at)").eq("active", true).not("ad_account_id", "is", null).is("clients.archived_at", null),
    admin.from("kpi_snapshots").select("target_id, windows"),
  ]);
  const spent = new Map((snaps ?? []).map((s) => [s.target_id as string, Number((s.windows as Record<string, { spend?: number }> | null)?.[window]?.spend ?? 0)]));
  return ((targets ?? []) as unknown as TargetRow[]).filter((t) => (LIVE as readonly string[]).includes(t.clients.status) && (spent.get(t.id) ?? 0) > 0);
}

/** Queues this week's (or this month's) reports that don't exist yet (one client's, with onlyClient). Safe to run again. */
export async function queueReports(admin: SupabaseClient, kind: "weekly" | "monthly", today = nyParts(new Date()).date, onlyClient?: string) {
  const p = periodsFor(kind, today).main;
  const targets = (await liveTargets(admin, kind === "weekly" ? "d7" : "d30")).filter((t) => !onlyClient || t.client_id === onlyClient);
  let created = 0;
  if (kind === "monthly") {
    for (const clientId of new Set(targets.map((t) => t.client_id))) {
      const { data: bundle } = await admin.from("report_bundles").upsert({ client_id: clientId, kind: "monthly", period_start: p.start, period_end: p.end }, { onConflict: "client_id,kind,period_start", ignoreDuplicates: false }).select("id").single();
      for (const t of targets.filter((x) => x.client_id === clientId)) {
        const { data } = await admin.from("reports").upsert({ client_id: clientId, target_id: t.id, bundle_id: bundle?.id ?? null, platform: t.platform, kind, period_start: p.start, period_end: p.end, owner_id: t.owner_id }, { onConflict: "target_id,kind,period_start", ignoreDuplicates: true }).select("id");
        created += data?.length ?? 0;
      }
    }
  } else
    for (const t of targets) {
      const { data } = await admin.from("reports").upsert({ client_id: t.client_id, target_id: t.id, platform: t.platform, kind, period_start: p.start, period_end: p.end, owner_id: t.owner_id }, { onConflict: "target_id,kind,period_start", ignoreDuplicates: true }).select("id");
      created += data?.length ?? 0;
    }
  return created;
}

/** Drafts queued reports, a few at a time (each is a writer and a QA pass), until the time runs out. */
export async function draftQueued(admin: SupabaseClient, budgetMs = 600_000) {
  const until = Date.now() + budgetMs;
  let done = 0;
  while (Date.now() < until - 150_000) {
    // Queued ones, and any stuck mid-draft for 20 minutes (a timeout), monthly first (they're critical)
    const stuck = new Date(Date.now() - 20 * 60_000).toISOString();
    const { data } = await admin.from("reports").select("id").or(`status.eq.queued,and(status.eq.drafting,updated_at.lt.${stuck})`).order("kind", { ascending: true }).order("created_at").limit(3);
    if (!data?.length) break;
    await Promise.all(data.map((r) => draftReport(admin, r.id)));
    done += data.length;
  }
  return done;
}

type Loaded = { id: string; kind: "weekly" | "monthly" | "custom"; platform: "meta" | "google"; period_start: string; period_end: string; message: string | null; sections: Sections | null; metrics: ReportMetrics | null; extras: string | null; client_id: string; bundle_id: string | null; owner: string | null; client: { name: string; slack_channel_id: string | null } };

async function load(admin: SupabaseClient, id: string): Promise<Loaded> {
  const { data: r } = await admin.from("reports").select("id, kind, platform, period_start, period_end, message, sections, metrics, extras, client_id, bundle_id, clients(name, slack_channel_id), profiles!reports_owner_id_fkey(full_name)").eq("id", id).single();
  if (!r) throw new Error("Report not found");
  return { ...(r as unknown as Loaded), owner: (r.profiles as unknown as { full_name: string } | null)?.full_name ?? null, client: r.clients as unknown as Loaded["client"] };
}

/** A post from the Kaizen app itself (its bot), when it can't go out as a person. */
async function botPost(channel: string, text: string): Promise<{ ok: boolean; ts?: string }> {
  if (!process.env.SLACK_BOT_TOKEN) return { ok: false };
  const res = await fetch("https://slack.com/api/chat.postMessage", { method: "POST", headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify({ channel, text, unfurl_links: false }) });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; ts?: string };
  return { ok: Boolean(body.ok), ts: body.ts };
}

const label = (start: string, end: string) => {
  const f = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${f(start)} – ${f(end)}`;
};
const monthOf = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** The PDF for one report, or for a whole monthly bundle (every submitted part). */
export async function reportPdf(admin: SupabaseClient, reports: Loaded[]) {
  const first = reports[0];
  return renderReportPdf({
    client: first.client.name,
    // An on-demand recap reads like a weekly one (its period, against the days before it)
    kind: first.kind === "monthly" ? "monthly" : "weekly",
    periodLabel: first.kind === "monthly" ? monthOf(first.period_start) : label(first.period_start, first.period_end),
    parts: reports.filter((r) => r.metrics && r.sections).map((r) => ({ platform: r.platform, buyer: r.owner, metrics: r.metrics!, sections: r.sections!, extras: r.extras })),
  });
}

/** A weekly report (or an on-demand recap) goes to the client's Slack channel, as the buyer, with its PDF. */
export async function postWeekly(admin: SupabaseClient, id: string, by: { id: string }) {
  const r = await load(admin, id);
  if (!r.client.slack_channel_id) throw new Error("This client has no Slack channel set. Add it on the client page.");
  if (!r.message?.trim()) throw new Error("There's no message to post yet.");
  const bytes = await reportPdf(admin, [r]);
  const out = await postAsUser(by.id, {
    channel: r.client.slack_channel_id,
    text: r.message,
    pdf: { filename: `${r.client.name} - ${r.platform === "google" ? "Google" : "Meta"} - ${label(r.period_start, r.period_end)}.pdf`, title: `${r.client.name} · ${r.platform === "google" ? "Google" : "Meta"} Ads · ${label(r.period_start, r.period_end)}`, bytes },
  });
  if (!out.ok) return out;
  await admin.from("reports").update({ status: "posted", posted_at: new Date().toISOString(), posted_by: by.id, slack_channel: out.channel, slack_ts: out.ts || null, updated_at: new Date().toISOString() }).eq("id", id);
  return out;
}

/**
 * A buyer submits their part of the monthly recap. It waits for every other part on the client (the other platform's
 * buyer); when the last one is in, the recap goes to the client. Returns what happened, for the buyer to see.
 */
export async function submitMonthly(admin: SupabaseClient, id: string, by: { id: string }) {
  const r = await load(admin, id);
  if (!r.bundle_id) throw new Error("This report isn't part of a monthly recap.");
  await admin.from("reports").update({ status: "submitted", submitted_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", id);
  const { data: parts } = await admin.from("reports").select("id, platform, status, profiles!reports_owner_id_fkey(full_name)").eq("bundle_id", r.bundle_id).neq("status", "skipped");
  const waiting = (parts ?? []).filter((p) => p.status !== "submitted" && p.status !== "posted");
  if (waiting.length)
    return {
      sent: false,
      waitingOn: waiting.map((p) => `${(p.profiles as unknown as { full_name: string } | null)?.full_name ?? "the other buyer"} (${p.platform === "google" ? "Google" : "Meta"})`),
    };
  await deliverBundle(admin, r.bundle_id, by);
  return { sent: true, waitingOn: [] as string[] };
}

/** Sends the monthly recap to the client: a Slack post (as the buyer who completed it) and an email to their contacts. */
export async function deliverBundle(admin: SupabaseClient, bundleId: string, by: { id: string }) {
  const { data: b } = await admin.from("report_bundles").update({ status: "sending" }).eq("id", bundleId).eq("status", "collecting").select("id, token, client_id, period_start").maybeSingle();
  if (!b) return; // already sent (or being sent)
  try {
    const { data: ids } = await admin.from("reports").select("id").eq("bundle_id", bundleId).in("status", ["submitted", "posted"]);
    const parts = await Promise.all((ids ?? []).map((x) => load(admin, x.id)));
    const client = parts[0].client;
    const link = `${SITE()}/r/${b.token}`;
    const month = monthOf(b.period_start);
    const bytes = await reportPdf(admin, parts);
    const intro = parts.map((p) => p.message?.trim()).filter(Boolean).join("\n\n");
    const text = `${intro}\n\n*Your ${month} recap:* ${link}`;
    const delivered: Record<string, unknown> = {};
    if (client.slack_channel_id) {
      const out = await postAsUser(by.id, { channel: client.slack_channel_id, text, pdf: { filename: `${client.name} - ${month} recap.pdf`, title: `${client.name} · ${month} recap`, bytes } });
      // The buyer who completed it hasn't connected Slack: the recap still goes out, from the Kaizen app (with the link)
      const fallback = !out.ok ? await botPost(client.slack_channel_id, text) : null;
      delivered.slack = out.ok ? { channel: out.channel, ts: out.ts } : fallback?.ok ? { channel: client.slack_channel_id, ts: fallback.ts, as: "app" } : { error: out.error };
    }
    // Email to the client's contacts (primary first)
    const { data: links } = await admin.from("contact_clients").select("is_primary, contacts(email, full_name)").eq("client_id", b.client_id);
    const to = (links ?? []).map((l) => l.contacts as unknown as { email: string; full_name: string | null } | null).filter((c): c is { email: string; full_name: string | null } => Boolean(c?.email));
    const headline = parts.map((p) => p.sections?.headline).filter(Boolean).join(" · ");
    const sentTo: string[] = [];
    for (const c of to.slice(0, 6)) {
      const res = await sendEmail({
        to: c.email,
        subject: `Your ${month} recap from Kaizen`,
        text: `Hi ${c.full_name?.split(" ")[0] ?? "there"},\n\nYour ${month} recap is ready: ${link}\n\n${headline}\n\nThe Kaizen team`,
        html: `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;color:#17131a"><p style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#c8102e;margin:0 0 16px">Kaizen Marketing</p><h1 style="font-size:24px;line-height:1.25;margin:0 0 12px">Your ${month} recap is ready</h1><p style="font-size:15px;line-height:1.6;color:#4d464f;margin:0 0 24px">${headline.replace(/[<>&]/g, "")}</p><a href="${link}" style="display:inline-block;background:#c8102e;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:999px">See the recap</a><p style="font-size:12px;color:#8a8189;margin:24px 0 0">You can download it as a PDF from the page.</p></div>`,
      });
      if (res.ok) sentTo.push(c.email);
    }
    delivered.email = sentTo;
    await admin.from("report_bundles").update({ status: "sent", sent_at: new Date().toISOString(), delivered }).eq("id", bundleId);
    await admin.from("reports").update({ status: "posted", posted_at: new Date().toISOString(), posted_by: by.id }).eq("bundle_id", bundleId).eq("status", "submitted");
  } catch (e) {
    await admin.from("report_bundles").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 400) }).eq("id", bundleId);
    throw e;
  }
}

/** Reminders: weekly reports not posted by Monday afternoon; monthly parts not submitted as the 5th nears (Slack-free: in the app and by email via notifications). */
export async function remindReports(admin: SupabaseClient, today = nyParts(new Date()).date) {
  const { data } = await admin.from("reports").select("id, kind, owner_id, client_id, period_start, status, clients(name)").in("status", ["draft", "failed"]).gte("period_start", new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10));
  const day = Number(today.slice(8, 10));
  let n = 0;
  for (const r of data ?? []) {
    if (!r.owner_id) continue;
    const name = (r.clients as unknown as { name: string }).name;
    const monthly = r.kind === "monthly";
    if (monthly && day > 5) continue;
    await admin.from("notifications").upsert(
      {
        profile_id: r.owner_id,
        kind: "report",
        title: monthly ? `${name}: the monthly recap is due by the 5th` : `${name}: this week's report hasn't gone out`,
        body: monthly ? "Submit your part so it can go to the client. It goes out once every buyer on the account has submitted." : "It's drafted and checked: read it over and post it.",
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
