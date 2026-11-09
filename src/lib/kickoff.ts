import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson } from "@/lib/ai";
import { gtmForContext } from "@/lib/gtm";
import { servicesOf } from "@/lib/services";
import { orderSeats, type SeatRow } from "@/lib/buyer-seats";
import { planSignedOff, strategyCalls } from "@/lib/execution-plan";

// Two messages in a new client's external Slack channel. "Meet your team" goes on its own (once) as soon as the channel
// is connected and their team is assigned: who's on it, what we do for them and what happens next; while client
// outreach is held it waits as a draft a buyer or lead can send. Then the go-to-market and 90-day roadmap message (the
// kickoff), written once three things are true: the intake form is in, the client has approved their plan (or it was
// approved on its own), and the team has had its internal strategy meeting about them. A buyer or lead reviews it,
// edits it and sends it; it never goes on its own. Both are kept as the client's Slack history.

export type KickoffRow = { status: "waiting" | "writing" | "draft" | "sent" | "failed"; missing: string[]; text: string; error: string | null; draftedAt: string | null; sentAt: string | null; sentBy: string | null; sentAs: "person" | "app" | null; forced: boolean };

export const INTAKE_MISSING = "the intake form";

/** What the kickoff still waits on (empty when it can be written) */
export async function kickoffGate(admin: SupabaseClient, clientId: string) {
  const [{ count: intakes }, { data: deck }] = await Promise.all([
    admin.from("client_intakes").select("id", { count: "exact", head: true }).eq("client_id", clientId),
    admin.from("client_presentations").select("status, approved_at").eq("client_id", clientId).maybeSingle(),
  ]);
  const approved = deck?.status === "approved";
  const calls = approved ? await strategyCalls(admin, clientId, (deck?.approved_at as string | null) ?? null) : [];
  const missing: string[] = [];
  if (!intakes) missing.push(INTAKE_MISSING);
  if (!approved) missing.push("their plan approved");
  if (!calls.length) missing.push("the internal strategy meeting");
  return { missing, calls };
}

const ROLE_NAMES: Record<string, string> = { meta_buyer: "Meta ads", google_buyer: "Google ads", graphic_designer: "Design", video_editor: "Video", copywriter: "Copy", coordinator: "Your point of contact" };

/** Write the draft (once). `force` writes it without the intake form (a lead's call). */
export async function draftKickoff(admin: SupabaseClient, clientId: string, force: { by: string } | null = null) {
  const { data: row } = await admin.from("client_kickoffs").select("status").eq("client_id", clientId).maybeSingle();
  if (row?.status === "sent" || row?.status === "draft") return { status: row.status as "sent" | "draft" };
  const gate = await kickoffGate(admin, clientId);
  const blocking = force ? gate.missing.filter((m) => m !== INTAKE_MISSING) : gate.missing;
  if (blocking.length) {
    await admin.from("client_kickoffs").upsert({ client_id: clientId, status: "waiting", missing: gate.missing, updated_at: new Date().toISOString() }, { onConflict: "client_id" });
    return { status: "waiting" as const, missing: gate.missing };
  }
  await admin.from("client_kickoffs").upsert({ client_id: clientId, status: "writing", missing: [], error: null, ...(force ? { forced_by: force.by } : {}), updated_at: new Date().toISOString() }, { onConflict: "client_id" });
  try {
    const [{ data: c }, { data: seats }, plan] = await Promise.all([
      admin.from("clients").select("name, slug, services, services_extra, services_removed").eq("id", clientId).single(),
      admin.from("client_assignments").select("role, profiles(full_name)").eq("client_id", clientId),
      planSignedOff(admin, clientId),
    ]);
    const services = servicesOf(c ?? {});
    const team = (seats ?? []).map((s) => `${ROLE_NAMES[s.role as string] ?? s.role}: ${(s.profiles as unknown as { full_name: string } | null)?.full_name ?? ""}`).filter((x) => !x.endsWith(": "));
    const [meta, google] = await Promise.all([services.includes("facebook-ads") ? gtmForContext(admin, clientId, "meta") : null, services.includes("google-ads") ? gtmForContext(admin, clientId, "google") : null]);
    const { data: full } = plan.signedOff ? await admin.from("client_execution_plans").select("markdown").eq("client_id", clientId).maybeSingle() : { data: null };
    const out = await askJson<{ text: string }>({
      agent: "strategist",
      label: `kickoff message ${c?.name ?? clientId}`,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 4000,
      schema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string" } } },
      system: `You write the message Kaizen Marketing posts in a new client's shared Slack channel with their go-to-market strategy and 90-day roadmap, from their team. Their team was already introduced in an earlier "Meet your team" message. It's the moment the client sees we're organized and moving.
Slack mrkdwn (*bold*, bullet lines starting with "• "), no headings with #, no emoji spam (one or two at most), no em dashes. Warm, confident, specific, short sentences. 160 to 300 words.
Structure: a one-line opener (their plan is set and here's how we'll get them there, mentioning the people leading it by first name from <team> in one line); *What we're doing first* (per platform Kaizen runs for them: what launches, for what goal, in plain words; no jargon, no internal terms like "execution plan"); *Your first 90 days* (Days 1 to 30, 31 to 60, 61 to 90: one or two lines each); *What we need from you* (only real open items, if any); a short close inviting questions here.
Only what's in the sources. Never promise results, numbers or dates the sources don't state. Never mention internal meetings, AI, tools or scores.`,
      prompt: [
        `<client>${c?.name ?? ""}</client>`,
        `<services>${services.join(", ")}</services>`,
        `<team>\n${team.join("\n") || "No one assigned yet: write the team section generally ('your Kaizen team')"}\n</team>`,
        plan.signedOff ? `<final_plan>\n${(full?.markdown as string) ?? plan.summary}\n</final_plan>` : "",
        !plan.signedOff && meta ? `<meta_strategy>\n${meta.slice(0, 12000)}\n</meta_strategy>` : "",
        !plan.signedOff && google ? `<google_strategy>\n${google.slice(0, 12000)}\n</google_strategy>` : "",
        gate.calls.length ? `<strategy_meeting>\n${gate.calls.map((x) => x.text).join("\n\n")}\n</strategy_meeting>` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    const now = new Date().toISOString();
    await admin.from("client_kickoffs").update({ status: "draft", text: out.text.trim(), drafted_at: now, updated_at: now }).eq("client_id", clientId);
    // The buyers and the leads: it's ready to review and send
    const [{ data: buyers }, { data: leads }] = await Promise.all([
      admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "google_buyer"]),
      admin.from("profiles").select("id").eq("is_active", true).eq("is_lead", true),
    ]);
    const ids = [...new Set([...(buyers ?? []).map((b) => b.profile_id as string), ...(leads ?? []).map((l) => l.id as string)])];
    if (ids.length)
      await admin.from("notifications").upsert(
        ids.map((id) => ({ profile_id: id, kind: "onboarding", title: `${c?.name}: their 90-day roadmap message is ready to send`.slice(0, 200), body: "What we're doing first on each platform and their first 90 days, written for their Slack channel. Review it, edit anything and send it.", href: `/clients/${c?.slug}?tab=plan`, client_id: clientId, key: `kickoff:${clientId}`, priority: "critical" })),
        { onConflict: "profile_id,key", ignoreDuplicates: true },
      );
    return { status: "draft" as const };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await admin.from("client_kickoffs").update({ status: "failed", error: error.slice(0, 500), updated_at: new Date().toISOString() }).eq("client_id", clientId);
    return { status: "failed" as const, error };
  }
}

/** Send it to the client's channel: as the person (their Slack) or, if they haven't connected Slack, as the Kaizen app */
export async function sendKickoff(admin: SupabaseClient, clientId: string, by: string, text: string) {
  const [{ data: row }, { data: c }] = await Promise.all([admin.from("client_kickoffs").select("status").eq("client_id", clientId).maybeSingle(), admin.from("clients").select("slack_channel_id").eq("id", clientId).single()]);
  if (row?.status === "sent") return { ok: false as const, error: "It's already been sent." };
  if (row?.status !== "draft") return { ok: false as const, error: "There's no kickoff message to send yet." };
  if (!c?.slack_channel_id) return { ok: false as const, error: "This client has no Slack channel connected. Add it on the client page first." };
  const body = text.trim().slice(0, 12000);
  if (!body) return { ok: false as const, error: "The message is empty." };
  const { postAsApp, postAsUser } = await import("@/lib/slack-user");
  let sentAs: "person" | "app" = "person";
  let r = await postAsUser(by, { channel: c.slack_channel_id as string, text: body });
  if (!r.ok && "needsConnect" in r && r.needsConnect) {
    sentAs = "app";
    r = await postAsApp({ channel: c.slack_channel_id as string, text: body });
  }
  if (!r.ok) return { ok: false as const, error: ("error" in r && r.error) || "Slack didn't take it. Try again in a minute." };
  const now = new Date().toISOString();
  const ts = ("ts" in r ? (r.ts as string | undefined) : undefined) ?? null;
  await admin.from("client_kickoffs").update({ status: "sent", sent_at: now, sent_by: by, sent_text: body, text: body, sent_as: sentAs, slack_ts: ts, updated_at: now }).eq("client_id", clientId);
  await admin.from("client_slack_messages").insert({ client_id: clientId, kind: "roadmap", status: "sent", text: body, auto: false, sent_at: now, sent_by: by, sent_as: sentAs, slack_ts: ts });
  await admin.from("notifications").delete().eq("key", `kickoff:${clientId}`).is("read_at", null);
  return { ok: true as const, sentAs };
}

/** Every few minutes: write the kickoff for any client whose three conditions just came true (one per run) */
export async function keepKickoffs(admin: SupabaseClient) {
  const { data: approved } = await admin.from("client_presentations").select("client_id, clients!inner(name, archived_at)").eq("status", "approved").is("clients.archived_at", null).limit(200);
  const ids = (approved ?? []).map((a) => a.client_id as string);
  if (!ids.length) return {};
  const { data: rows } = await admin.from("client_kickoffs").select("client_id, status, updated_at").in("client_id", ids);
  const out: Record<string, string> = {};
  for (const a of approved ?? []) {
    const r = (rows ?? []).find((x) => x.client_id === a.client_id);
    if (r && ["draft", "sent"].includes(r.status as string)) continue;
    if (r?.status === "writing" && Date.now() - Date.parse(r.updated_at as string) < 30 * 60_000) continue;
    if (r?.status === "failed" && Date.now() - Date.parse(r.updated_at as string) < 6 * 3_600_000) continue;
    const res = await draftKickoff(admin, a.client_id as string);
    if (res.status !== "waiting") {
      out[(a.clients as unknown as { name: string }).name] = res.status;
      break; // one written per run
    }
  }
  return out;
}

export async function loadKickoff(db: SupabaseClient, clientId: string): Promise<KickoffRow | null> {
  const { data } = await db.from("client_kickoffs").select("status, missing, text, error, drafted_at, sent_at, sent_as, forced_by, profiles:sent_by(full_name)").eq("client_id", clientId).maybeSingle();
  if (!data) return null;
  return {
    status: data.status as KickoffRow["status"],
    missing: (data.missing as string[] | null) ?? [],
    text: (data.text as string) ?? "",
    error: (data.error as string | null) ?? null,
    draftedAt: (data.drafted_at as string | null) ?? null,
    sentAt: (data.sent_at as string | null) ?? null,
    sentBy: (data.profiles as unknown as { full_name: string } | null)?.full_name ?? null,
    sentAs: (data.sent_as as "person" | "app" | null) ?? null,
    forced: Boolean(data.forced_by),
  };
}

// ─── Meet your team ───

const DOES: Record<string, string> = {
  meta_buyer: "your Meta media buyer: plans, builds and optimizes your Facebook and Instagram ads",
  google_buyer: "your Google Ads buyer: runs your search, shopping and YouTube campaigns",
  graphic_designer: "your designer: makes your ad images and carousels",
  video_editor: "your video editor: cuts your ad videos",
  copywriter: "your copywriter: writes the words on your ads",
  coordinator: "your point of contact: keeps everything on track and answers your questions",
};
const SEAT_ORDER = ["coordinator", "meta_buyer", "google_buyer", "graphic_designer", "video_editor", "copywriter"];
const SERVICE_LINE: Record<string, string> = {
  "facebook-ads": "Meta ads (Facebook and Instagram)",
  "google-ads": "Google Ads",
  "tiktok-ads": "TikTok ads",
  creative: "Ad creative (images and video)",
  "email-marketing": "Email marketing",
  "web-design": "Web design",
  "social-media": "Social media",
  crm: "CRM",
};

type Seats = Record<string, { id: string; name: string }>;

async function seatsOf(admin: SupabaseClient, clientId: string): Promise<Seats> {
  const { data } = await admin.from("client_assignments").select("role, profile_id, is_primary, created_at, profiles(full_name)").eq("client_id", clientId);
  const out: Seats = {};
  // Each seat's primary
  for (const s of orderSeats((data ?? []) as unknown as (SeatRow & { profiles: unknown })[])) {
    const name = (s.profiles as unknown as { full_name: string } | null)?.full_name;
    if (name && !out[s.role as string]) out[s.role as string] = { id: s.profile_id as string, name };
  }
  return out;
}

/** The seats a client needs before we introduce the team: a buyer for each ad platform, a maker for creative */
function teamReady(services: string[], seats: Seats) {
  if (services.includes("facebook-ads") && !seats.meta_buyer) return false;
  if (services.includes("google-ads") && !seats.google_buyer) return false;
  if (services.includes("creative") && !seats.graphic_designer && !seats.video_editor) return false;
  return Object.keys(seats).length > 0;
}

export function meetTeamText(name: string, services: string[], seats: Seats, portal: string | null) {
  const team = SEAT_ORDER.filter((r) => seats[r]).map((r) => `• *${seats[r].name}*, ${DOES[r]}`);
  return [
    `Welcome to Kaizen, ${name}! Here's the team working with you.`,
    "",
    "*Your team*",
    ...team,
    "",
    "*What we're doing for you*",
    ...services.filter((s) => SERVICE_LINE[s]).map((s) => `• ${SERVICE_LINE[s]}`),
    "",
    "*What happens next*",
    `• Finish your setup${portal ? ` in your portal (access, your brand assets and the look you want): ${portal}` : " (access, your brand assets and the look you want)"}`,
    "• Fill in your marketing intake form, so we can write your plan",
    "• Your plan is coming: how we see your brand, for you to approve",
    "",
    "Questions? Ask right here, any time.",
  ].join("\n");
}

async function post(channel: string, text: string, by: string | null) {
  const { postAsApp, postAsUser } = await import("@/lib/slack-user");
  let sentAs: "person" | "app" = by ? "person" : "app";
  let r = by ? await postAsUser(by, { channel, text }) : await postAsApp({ channel, text });
  if (!r.ok && by && r.needsConnect) {
    sentAs = "app";
    r = await postAsApp({ channel, text });
  }
  return r.ok ? { ok: true as const, sentAs, ts: r.ts } : { ok: false as const, error: r.error };
}

/**
 * Every few minutes: introduce the team to each new client whose Slack channel and team are in (once), and tell a
 * client when the person in one of their seats changes. Both go on their own only when client outreach allows it;
 * otherwise they wait as a draft for a buyer or lead to send.
 */
export async function keepMeetTeam(admin: SupabaseClient) {
  const { FLOW_START } = await import("@/lib/presentation-types");
  const { autoOutreach } = await import("@/lib/client-outreach");
  const { siteUrl } = await import("@/lib/site");
  const { data: clients } = await admin
    .from("clients")
    .select("id, name, slug, slack_channel_id, portal_live, services, services_extra, services_removed")
    .is("archived_at", null)
    .not("slack_channel_id", "is", null)
    .or(`created_at.gte.${FLOW_START},reonboarded_at.gte.${FLOW_START}`)
    .limit(200);
  const out: Record<string, string> = {};
  if (!clients?.length) return out;
  const { data: sent } = await admin.from("client_slack_messages").select("client_id, kind, status, team, created_at").in("client_id", clients.map((c) => c.id as string)).in("kind", ["meet_team", "team_change"]).order("created_at", { ascending: false });
  for (const c of clients) {
    const id = c.id as string;
    const services = servicesOf(c);
    const seats = await seatsOf(admin, id);
    const team = Object.fromEntries(Object.entries(seats).map(([r, s]) => [r, s.id]));
    const meet = (sent ?? []).find((m) => m.client_id === id && m.kind === "meet_team");
    if (!meet) {
      if (!teamReady(services, seats)) continue;
      const text = meetTeamText(c.name as string, services, seats, c.portal_live ? `${siteUrl()}/c/${c.slug}/start` : null);
      if (!(await autoOutreach(admin, id))) {
        await admin.from("client_slack_messages").insert({ client_id: id, kind: "meet_team", status: "held", text, team, auto: true });
        out[c.name as string] = "meet your team: held (client outreach is off)";
        continue;
      }
      const r = await post(c.slack_channel_id as string, text, null);
      await admin.from("client_slack_messages").insert({ client_id: id, kind: "meet_team", status: r.ok ? "sent" : "failed", text, team, auto: true, error: r.ok ? null : r.error, sent_at: r.ok ? new Date().toISOString() : null, sent_as: r.ok ? r.sentAs : null, slack_ts: r.ok ? r.ts : null });
      out[c.name as string] = r.ok ? "meet your team: sent" : `meet your team: ${r.error}`;
      continue;
    }
    if (meet.status !== "sent") continue;
    // A seat that changed hands since the team was introduced (or last updated): a short note, once per change
    const last = (sent ?? []).find((m) => m.client_id === id && m.status === "sent" && m.team);
    const before = (last?.team ?? {}) as Record<string, string>;
    const changed = SEAT_ORDER.filter((r) => before[r] && seats[r] && seats[r].id !== before[r]);
    if (!changed.length) continue;
    const text = changed.map((r) => `Quick update on your team: *${seats[r].name}* is now ${DOES[r]}.`).join("\n");
    if (!(await autoOutreach(admin, id))) {
      const held = (sent ?? []).some((m) => m.client_id === id && m.kind === "team_change" && m.status === "held" && JSON.stringify(m.team) === JSON.stringify(team));
      if (!held) await admin.from("client_slack_messages").insert({ client_id: id, kind: "team_change", status: "held", text, team, auto: true });
      continue;
    }
    const r = await post(c.slack_channel_id as string, text, null);
    await admin.from("client_slack_messages").insert({ client_id: id, kind: "team_change", status: r.ok ? "sent" : "failed", text, team, auto: true, error: r.ok ? null : r.error, sent_at: r.ok ? new Date().toISOString() : null, sent_as: r.ok ? r.sentAs : null, slack_ts: r.ok ? r.ts : null });
    out[c.name as string] = r.ok ? "team change: sent" : `team change: ${r.error}`;
  }
  return out;
}

/** A buyer or lead sends a held message (Meet your team, or a team change) by hand, as themselves */
export async function sendHeldMessage(admin: SupabaseClient, clientId: string, messageId: string, by: string, text: string) {
  const [{ data: m }, { data: c }] = await Promise.all([admin.from("client_slack_messages").select("status").eq("id", messageId).eq("client_id", clientId).maybeSingle(), admin.from("clients").select("slack_channel_id").eq("id", clientId).single()]);
  if (!m || m.status === "sent") return { ok: false as const, error: m ? "It's already been sent." : "Not found." };
  if (!c?.slack_channel_id) return { ok: false as const, error: "This client has no Slack channel connected." };
  const body = text.trim().slice(0, 12000);
  if (!body) return { ok: false as const, error: "The message is empty." };
  const r = await post(c.slack_channel_id as string, body, by);
  if (!r.ok) return { ok: false as const, error: r.error || "Slack didn't take it." };
  await admin.from("client_slack_messages").update({ status: "sent", text: body, sent_at: new Date().toISOString(), sent_by: by, sent_as: r.sentAs, slack_ts: r.ts, error: null }).eq("id", messageId);
  return { ok: true as const };
}

export type SlackMessage = { id: string; kind: "meet_team" | "team_change" | "roadmap"; status: "held" | "sent" | "failed"; text: string; auto: boolean; error: string | null; sentAt: string | null; sentBy: string | null; sentAs: "person" | "app" | null; createdAt: string };

export async function loadSlackMessages(db: SupabaseClient, clientId: string): Promise<SlackMessage[]> {
  const { data } = await db.from("client_slack_messages").select("id, kind, status, text, auto, error, sent_at, sent_as, created_at, profiles:sent_by(full_name)").eq("client_id", clientId).order("created_at", { ascending: false }).limit(20);
  return (data ?? []).map((m) => ({ id: m.id as string, kind: m.kind as SlackMessage["kind"], status: m.status as SlackMessage["status"], text: m.text as string, auto: Boolean(m.auto), error: (m.error as string | null) ?? null, sentAt: (m.sent_at as string | null) ?? null, sentBy: (m.profiles as unknown as { full_name: string } | null)?.full_name ?? null, sentAs: (m.sent_as as "person" | "app" | null) ?? null, createdAt: m.created_at as string }));
}
