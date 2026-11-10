import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SANDBOX_SLUG } from "@/lib/client-outreach";
import { clientRecipients, logClientEmail } from "@/lib/client-emails";
import { sendEmail } from "@/lib/email";
import { emailHtml, emailText } from "@/lib/email-layout";
import { isWhiteLabel } from "@/lib/reports/white-label";
import { siteUrl } from "@/lib/site";
import { postAsApp } from "@/lib/slack-user";
import {
  AUTO_APPROVED_BY,
  chasers,
  clientMessage,
  dueTimes,
  addBusinessDays,
  noticeKey,
  planClient,
  roundOf,
  timelineLine,
  type Logged,
  type NoticeKind,
  type Waiting,
} from "@/lib/approval-notices-core";

// Closing the approval loop: creative with the client gets a short Slack post in the client's channel (and an email to
// their portal contacts), a reminder at 24 business hours and another at 48, and at 48 it goes to customer success's
// "Waiting on the client" queue with a team notification. A client who opted into auto-approval has what waited 48
// business hours approved for them instead, with a note to them and the team. Every notice is logged by item and kind
// (approval_notices) and shows on the ticket's timeline. Run by the "approvals" cron step in business hours.
//
// Nothing reaches a client unless every switch is on: the portal live, Kaizen's client outreach hold lifted (Settings,
// app_settings client_outreach, or the sandbox client), and the client's own Client notifications (Team & setup).

type Admin = SupabaseClient;
type ClientRow = { id: string; name: string; slug: string; portal_live: boolean; client_notifications: boolean; auto_approve_opt_in: boolean; client_type: string | null; slack_channel_id: string | null; internal_slack_channel_id: string | null; archived_at: string | null };
type ReqRow = { id: string; number: number; title: string; client_id: string; stage_entered_at: string; buyer_id: string | null; clients: ClientRow };

/** Whether Kaizen may reach clients on its own at all (the outreach hold), read once */
export async function outreachOn(admin: Admin) {
  const { data } = await admin.from("app_settings").select("value").eq("key", "client_outreach").maybeSingle();
  return Boolean((data?.value as { on?: boolean } | null)?.on);
}

/** Every switch that lets a notice reach this client */
export const canReach = (c: Pick<ClientRow, "portal_live" | "client_notifications" | "slug" | "archived_at">, globalOn: boolean) => Boolean(c.portal_live && c.client_notifications && !c.archived_at && (globalOn || c.slug === SANDBOX_SLUG));

/** Holidays around now, as "YYYY-MM-DD" (the business clock's table) */
async function holidaysNear(admin: Admin, now: Date) {
  const from = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  const to = new Date(now.getTime() + 60 * 86_400_000).toISOString().slice(0, 10);
  const { data } = await admin.from("holidays").select("day").gte("day", from).lte("day", to);
  return new Set((data ?? []).map((h) => String(h.day).slice(0, 10)));
}

/** The designs still waiting on the client on each ticket (current version uploaded, not approved yet) */
async function pendingPieces(admin: Admin, requestIds: string[]) {
  const out = new Map<string, string[]>();
  if (!requestIds.length) return out;
  const { data } = await admin.from("designs").select("id, request_id, client_status, current_version, design_versions(version, design_files(id))").in("request_id", requestIds);
  for (const d of (data ?? []) as unknown as { id: string; request_id: string; client_status: string | null; current_version: number; design_versions: { version: number; design_files: { id: string }[] }[] }[]) {
    if (d.client_status === "approved") continue;
    if (!d.design_versions.some((v) => v.version === d.current_version && v.design_files.length)) continue;
    out.set(d.request_id, [...(out.get(d.request_id) ?? []), d.id]);
  }
  return out;
}

const portalUrl = (slug: string) => `${siteUrl()}/c/${slug}`;

/** One message to the client: their Slack channel and their portal contacts' inboxes. Says where it went. */
async function tellClient(admin: Admin, c: ClientRow, kind: "ready" | "remind_24" | "remind_48" | "auto_approved", count: number) {
  const whiteLabel = isWhiteLabel(c.client_type);
  const m = clientMessage(kind, { count, url: portalUrl(c.slug), whiteLabel });
  const channels: string[] = [];
  const errors: string[] = [];
  if (c.slack_channel_id) {
    const r = await postAsApp({ channel: c.slack_channel_id, text: m.slack });
    if (r.ok) channels.push("slack");
    else errors.push(`Slack: ${r.error}`);
  }
  const to = await clientRecipients(admin, c.id).catch(() => []);
  if (to.length) {
    const sentTo: string[] = [];
    let first: { subject: string; html: string; text: string } | null = null;
    for (const x of to) {
      const parts = { preheader: m.lines[0], kicker: whiteLabel ? undefined : c.name, title: m.title, highlight: m.highlight, hello: x.first ? `Hi ${x.first},` : "Hi there,", lines: m.lines, cta: m.cta, whiteLabel };
      const mail = { subject: m.subject, html: emailHtml(parts), text: emailText(parts) };
      first ??= mail;
      const r = await sendEmail({ to: x.email, ...mail, ...(whiteLabel ? { fromName: "Creative review" } : {}) });
      if (r.ok) sentTo.push(x.email);
      else errors.push(`Email: ${r.error}`);
    }
    if (sentTo.length && first) {
      channels.push("email");
      await logClientEmail(admin, { clientId: c.id, kind: kind === "ready" ? "review" : kind === "auto_approved" ? "review_auto" : "review_reminder", ...first, to: sentTo }).catch(() => undefined);
    }
  }
  return { channels, errors, said: m.slack, nowhere: !c.slack_channel_id && !to.length };
}

/** Claim notices before sending (the unique key), so two runs never send the same one; returns the ones this run owns */
async function claim(admin: Admin, kind: NoticeKind, c: ClientRow, items: Waiting[]) {
  if (!items.length) return [] as Waiting[];
  const rows = items.map((w) => ({ key: noticeKey(kind, w.requestId, w.roundAt), client_id: c.id, request_id: w.requestId, round_at: roundOf(w.roundAt), kind, status: "sending" }));
  const { data, error } = await admin.from("approval_notices").upsert(rows, { onConflict: "key", ignoreDuplicates: true }).select("key");
  if (error) throw new Error(`approval_notices: ${error.message}`);
  const mine = new Set((data ?? []).map((r) => r.key as string));
  return items.filter((w) => mine.has(noticeKey(kind, w.requestId, w.roundAt)));
}

/** Settle claimed notices: kept as sent or held, or let go so the next run tries again */
async function settle(admin: Admin, kind: NoticeKind, items: Waiting[], o: { status: "sent" | "held" | "retry"; channels: string[]; detail: string }) {
  const keys = items.map((w) => noticeKey(kind, w.requestId, w.roundAt));
  if (!keys.length) return;
  if (o.status === "retry") {
    await admin.from("approval_notices").delete().in("key", keys);
    return;
  }
  await admin.from("approval_notices").update({ status: o.status, channels: o.channels, detail: o.detail.slice(0, 1000) }).in("key", keys);
  // The ticket's timeline: a line for each post and reminder
  if (o.status === "sent")
    await admin.from("request_events").insert(
      items.map((w) => ({ request_id: w.requestId, kind: "client_notice", body: kind === "escalated" || kind === "auto_approved" ? null : o.detail.slice(0, 1000), data: { action: kind, channels: o.channels, line: timelineLine(kind, o.channels) } })),
    );
}

/** Send one client-facing notice for a group of items: claim, tell them, settle */
async function notify(admin: Admin, kind: "ready" | "remind_24" | "remind_48", c: ClientRow, items: Waiting[], pieces: Map<string, string[]>) {
  const mine = await claim(admin, kind, c, items);
  if (!mine.length) return 0;
  const count = mine.reduce((n, w) => n + Math.max(1, pieces.get(w.requestId)?.length ?? w.pieces), 0);
  const r = await tellClient(admin, c, kind, count);
  if (r.channels.length) await settle(admin, kind, mine, { status: "sent", channels: r.channels, detail: r.said });
  else if (r.nowhere) await settle(admin, kind, mine, { status: "held", channels: [], detail: "No Slack channel and no active portal contact to reach." });
  else await settle(admin, kind, mine, { status: "retry", channels: [], detail: r.errors.join("; ") });
  return r.channels.length ? mine.length : 0;
}

/** The execs, for notices nobody else holds */
async function execIds(admin: Admin) {
  const { data } = await admin.from("profiles").select("id").eq("is_exec", true).eq("is_active", true).not("joined_at", "is", null);
  return (data ?? []).map((p) => p.id as string);
}

/** Approve what's still waiting on a ticket, as the client would: every design and copy ad, logged as automatic */
async function approveAll(admin: Admin, requestId: string, designIds: string[]) {
  const { data: s } = await admin.from("copy_sets").select("ads, client_status").eq("request_id", requestId).maybeSingle();
  const ads = ((s?.ads as unknown[] | null) ?? []).map((_, i) => i).filter((i) => ((s?.client_status as { status?: string }[] | null) ?? [])[i]?.status !== "approved");
  const { error } = await admin.rpc("client_submit_review", {
    p_request: requestId,
    p_designs: designIds.map((id) => ({ design_id: id, decision: "approved", note: "" })),
    p_ads: ads.map((index) => ({ index, decision: "approved", note: "" })),
    p_by_contact: null,
    p_by_profile: null,
    p_by_name: AUTO_APPROVED_BY,
  });
  if (error) return error.message;
  // The decision's own line on the timeline: automatic, not a team member testing
  const { data: ev } = await admin.from("request_events").select("id, data").eq("request_id", requestId).eq("kind", "review").order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (ev) await admin.from("request_events").update({ data: { ...((ev.data as Record<string, unknown>) ?? {}), testing: false, auto: true } }).eq("id", ev.id);
  return null;
}

/** The "approvals" cron step: every client with creative waiting on them */
export async function runApprovalNotices(admin: Admin, now = new Date()) {
  const { data: reqs, error } = await admin
    .from("requests")
    .select("id, number, title, client_id, stage_entered_at, buyer_id, clients!inner(id, name, slug, portal_live, client_notifications, auto_approve_opt_in, client_type, slack_channel_id, internal_slack_channel_id, archived_at)")
    .eq("stage", "client_review")
    .is("deleted_at", null)
    .eq("clients.portal_live", true);
  if (error) throw new Error(error.message);
  const rows = (reqs ?? []) as unknown as ReqRow[];
  const out = { clients: 0, posted: 0, reminded24: 0, reminded48: 0, escalated: 0, autoApproved: 0, errors: [] as string[] };
  if (!rows.length) return out;

  // A run that died mid-send leaves its claims: after half an hour they're let go, so the next run tries again
  await admin.from("approval_notices").delete().eq("status", "sending").lt("created_at", new Date(now.getTime() - 30 * 60_000).toISOString());
  const ids = rows.map((r) => r.id);
  const clientIds = [...new Set(rows.map((r) => r.client_id))];
  const dayStart = new Date(now.getTime() - 36 * 3_600_000).toISOString();
  const [globalOn, holidays, pieces, { data: byRequest }, { data: today }, { data: seats }, execs] = await Promise.all([
    outreachOn(admin),
    holidaysNear(admin, now),
    pendingPieces(admin, ids),
    admin.from("approval_notices").select("key, status, created_at").in("request_id", ids),
    // Today's posts on each client (a ticket since approved still counts toward the one post a day)
    admin.from("approval_notices").select("key, status, created_at").in("client_id", clientIds).eq("kind", "ready").gte("created_at", dayStart),
    admin.from("client_assignments").select("client_id, profile_id, role, is_primary").in("client_id", clientIds).eq("role", "coordinator"),
    execIds(admin),
  ]);
  const logged: Logged = new Map([...(byRequest ?? []), ...(today ?? [])].map((n) => [n.key as string, { at: n.created_at as string, status: n.status as string }]));

  for (const clientId of clientIds) {
    const mine = rows.filter((r) => r.client_id === clientId);
    const c = mine[0].clients;
    if (c.archived_at) continue;
    out.clients++;
    const items: Waiting[] = mine.map((r) => ({ requestId: r.id, number: r.number, title: r.title, roundAt: r.stage_entered_at, pieces: pieces.get(r.id)?.length ?? 1 }));
    const reach = canReach(c, globalOn);
    const plan = planClient({ items, logged, reach, optedIn: c.auto_approve_opt_in, now, holidays });
    try {
      if (plan.announce.length) out.posted += await notify(admin, "ready", c, plan.announce, pieces);
      if (plan.remind24.length) out.reminded24 += await notify(admin, "remind_24", c, plan.remind24, pieces);
      if (plan.remind48.length) out.reminded48 += await notify(admin, "remind_48", c, plan.remind48, pieces);

      // Auto-approval: opted-in clients only, what they were told about and left 48 business hours
      if (plan.autoApprove.length) {
        const owned = await claim(admin, "auto_approved", c, plan.autoApprove);
        const done: Waiting[] = [];
        for (const w of owned) {
          const err = await approveAll(admin, w.requestId, pieces.get(w.requestId) ?? []);
          if (err) {
            out.errors.push(`#${w.number}: ${err}`);
            await settle(admin, "auto_approved", [w], { status: "retry", channels: [], detail: err });
          } else done.push(w);
        }
        if (done.length) {
          const count = done.reduce((n, w) => n + Math.max(1, pieces.get(w.requestId)?.length ?? 1), 0);
          const told = await tellClient(admin, c, "auto_approved", count);
          const channels = [...told.channels, "team"];
          // The team: their internal channel, and the people on it
          const list = done.map((w) => `#${w.number} ${w.title}`).join(", ");
          if (c.internal_slack_channel_id) await postAsApp({ channel: c.internal_slack_channel_id, text: `${c.name}: ${done.length === 1 ? "1 ticket was" : `${done.length} tickets were`} approved automatically after 48 business hours with the client (they opted in): ${list}. Ready to launch.` }).catch(() => undefined);
          const to = [...new Set([...chasers((seats ?? []).filter((s) => s.client_id === clientId), execs), ...mine.filter((r) => done.some((w) => w.requestId === r.id)).map((r) => r.buyer_id).filter(Boolean)])] as string[];
          if (to.length)
            await admin.from("notifications").upsert(
              done.flatMap((w) =>
                to.map((profile_id) => ({ profile_id, kind: "client", title: `#${w.number} approved automatically: ${w.title}`, body: `${c.name} opted into auto-approval and left it 48 business hours. It's ready to launch.`, href: `/board?t=${w.number}`, client_id: c.id, key: `client-auto:${w.requestId}:${roundOf(w.roundAt)}`, priority: "normal" })),
              ),
              { onConflict: "profile_id,key", ignoreDuplicates: true },
            );
          await settle(admin, "auto_approved", done, { status: "sent", channels, detail: AUTO_APPROVED_BY });
          out.autoApproved += done.length;
        }
      }

      // Customer success: into their "Waiting on the client" queue, with a notification (the execs when nobody holds the seat)
      if (plan.escalate.length) {
        const owned = await claim(admin, "escalated", c, plan.escalate);
        if (owned.length) {
          const to = chasers((seats ?? []).filter((s) => s.client_id === clientId), execs);
          if (to.length)
            await admin.from("notifications").upsert(
              owned.flatMap((w) =>
                to.map((profile_id) => ({ profile_id, kind: "client", title: `Waiting on ${c.name} for 48 business hours: #${w.number} ${w.title}`, body: "No decision from the client yet. It's in your Waiting on the client list: give them a call or a nudge.", href: `/board?t=${w.number}`, client_id: c.id, key: `client-wait:${w.requestId}:${roundOf(w.roundAt)}`, priority: "normal" })),
              ),
              { onConflict: "profile_id,key", ignoreDuplicates: true },
            );
          await settle(admin, "escalated", owned, { status: "sent", channels: ["team"], detail: `Customer success queue (${to.length} ${to.length === 1 ? "person" : "people"})` });
          out.escalated += owned.length;
        }
      }
    } catch (e) {
      out.errors.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return out;
}

// ─── What the team sees ─────────────────────────────────────────────────────

export type ClientNoticesCard = {
  on: boolean;
  by: string | null;
  at: string | null;
  globalOn: boolean;
  sandbox: boolean;
  portalLive: boolean;
  optedIn: boolean;
  whiteLabel: boolean;
  slack: boolean;
  contacts: number;
  /** Every switch on: notices reach them */
  reaches: boolean;
  recent: { kind: NoticeKind; status: string; channels: string[]; detail: string | null; at: string; number: number | null; title: string | null }[];
  pending: { number: number; title: string; since: string; told: string | null; next: { what: string; at: string } | null }[];
};

/** The "Client notifications" card on Team & setup: the switch, the last posts, and what's coming for each item */
export async function loadClientNotices(admin: Admin, clientId: string, now = new Date()): Promise<ClientNoticesCard> {
  const [{ data: c }, globalOn, holidays, { data: recent }, { data: waiting }, contacts] = await Promise.all([
    admin.from("clients").select("slug, portal_live, client_notifications, client_notifications_at, client_type, auto_approve_opt_in, slack_channel_id, archived_at, profiles:client_notifications_by(full_name)").eq("id", clientId).single(),
    outreachOn(admin),
    holidaysNear(admin, now),
    admin.from("approval_notices").select("kind, status, channels, detail, created_at, requests(number, title)").eq("client_id", clientId).neq("status", "sending").order("created_at", { ascending: false }).limit(8),
    admin.from("requests").select("id, number, title, stage_entered_at").eq("client_id", clientId).eq("stage", "client_review").is("deleted_at", null).order("stage_entered_at"),
    clientRecipients(admin, clientId).catch(() => []),
  ]);
  const row = (c ?? {}) as Record<string, unknown>;
  const reaches = canReach({ portal_live: Boolean(row.portal_live), client_notifications: Boolean(row.client_notifications), slug: String(row.slug ?? ""), archived_at: (row.archived_at as string | null) ?? null }, globalOn);
  const optedIn = Boolean(row.auto_approve_opt_in);
  const ids = (waiting ?? []).map((w) => w.id as string);
  const { data: notes } = ids.length ? await admin.from("approval_notices").select("key, status, created_at").in("request_id", ids) : { data: [] };
  const logged: Logged = new Map((notes ?? []).map((n) => [n.key as string, { at: n.created_at as string, status: n.status as string }]));
  const pending = (waiting ?? []).map((w) => {
    const roundAt = w.stage_entered_at as string;
    const id = w.id as string;
    const has = (k: NoticeKind) => logged.has(noticeKey(k, id, roundAt));
    const ready = logged.get(noticeKey("ready", id, roundAt));
    const told = ready?.status === "sent" ? ready.at : null;
    let next: { what: string; at: string } | null = null;
    if (told && reaches) {
      const due = dueTimes(new Date(told), holidays);
      if (!has("remind_24") && !has("remind_48") && !has("auto_approved")) next = { what: "First reminder", at: due.remind24.toISOString() };
      else if (!has("remind_48") && !has("auto_approved")) next = { what: optedIn ? "Approved automatically" : "Second reminder, then customer success", at: due.remind48.toISOString() };
    } else if (reaches && !ready) next = { what: "Ready post", at: now.toISOString() };
    else if (!has("escalated")) next = { what: "Customer success queue", at: addBusinessDays(new Date(told ?? roundAt), 2, holidays).toISOString() };
    return { number: w.number as number, title: w.title as string, since: roundAt, told, next };
  });
  return {
    on: Boolean(row.client_notifications),
    by: (row.profiles as { full_name?: string } | null)?.full_name ?? null,
    at: (row.client_notifications_at as string | null) ?? null,
    globalOn,
    sandbox: row.slug === SANDBOX_SLUG,
    portalLive: Boolean(row.portal_live),
    optedIn,
    whiteLabel: isWhiteLabel(row.client_type as string | null),
    slack: Boolean(row.slack_channel_id),
    contacts: contacts.length,
    reaches,
    recent: (recent ?? []).map((r) => {
      const req = r.requests as unknown as { number: number; title: string } | null;
      return { kind: r.kind as NoticeKind, status: r.status as string, channels: (r.channels as string[] | null) ?? [], detail: (r.detail as string | null) ?? null, at: r.created_at as string, number: req?.number ?? null, title: req?.title ?? null };
    }),
    pending,
  };
}

// ─── Customer success's queue ───────────────────────────────────────────────

export type WaitingOnClient = { requestId: string; number: number; title: string; client: string; slug: string; since: string; escalatedAt: string };

/**
 * "Waiting on the client": tickets 48 business hours with the client and no decision, for the customer success person
 * on the client (the execs when nobody holds that seat). Gone the moment the client decides.
 */
export async function loadWaitingOnClient(db: Admin, me: { id: string; isExec: boolean }): Promise<WaitingOnClient[]> {
  const { data } = await db
    .from("approval_notices")
    .select("request_id, client_id, round_at, created_at, requests!inner(number, title, stage, stage_entered_at, deleted_at), clients(name, slug)")
    .eq("kind", "escalated")
    .eq("status", "sent")
    .eq("requests.stage", "client_review")
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = ((data ?? []) as unknown as { request_id: string; client_id: string; round_at: string | null; created_at: string; requests: { number: number; title: string; stage: string; stage_entered_at: string; deleted_at: string | null }; clients: { name: string; slug: string } | null }[]).filter(
    (r) => !r.requests.deleted_at && r.round_at && roundOf(r.round_at) === roundOf(r.requests.stage_entered_at),
  );
  if (!rows.length) return [];
  const { data: seats } = await db.from("client_assignments").select("client_id, profile_id, role, is_primary").in("client_id", [...new Set(rows.map((r) => r.client_id))]).eq("role", "coordinator");
  return rows
    .filter((r) => chasers((seats ?? []).filter((s) => s.client_id === r.client_id), me.isExec ? [me.id] : []).includes(me.id))
    .map((r) => ({ requestId: r.request_id, number: r.requests.number, title: r.requests.title, client: r.clients?.name ?? "", slug: r.clients?.slug ?? "", since: r.requests.stage_entered_at, escalatedAt: r.created_at }));
}

