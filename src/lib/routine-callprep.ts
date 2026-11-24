import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
import type { RoutineReport } from "@/lib/routines-core";
import { PEOPLE_RULE } from "@/lib/people-matters";

// Call prep (owner, Nov 24 2026; docs/kyle-scheduled-runs.md "Owner's additions" and #9's per-meeting prep): about an
// hour before each client or sales call on the person's calendar, a brief lands on their Routines page and in the
// bell. Client calls: the goal, what we owe and whether it's done, what they owe, the top risk with numbers, talking
// points, what to do or send before, and any integration that's down (the same reading as the afternoon-before check,
// src/lib/integration-health/precall.ts). Sales calls: what's known from Sales › Prospects and email, and discovery
// questions. Each meeting is prepped once. Never a client's fee.

type Admin = SupabaseClient;
type Me = { id: string; full_name: string; email: string; role: string; is_exec: boolean; is_lead: boolean };

/** How far ahead a call is prepped: starting between 30 and 90 minutes from now */
export const PREP_FROM_MIN = 30;
export const PREP_TO_MIN = 90;

const BRIEF = {
  type: "object",
  properties: {
    headline: { type: "string", description: "First sentence: the one thing to do or know before this call" },
    sections: { type: "array", items: { type: "object", properties: { title: { type: "string" }, lines: { type: "array", items: { type: "object", properties: { text: { type: "string" }, href: { type: ["string", "null"] }, tag: { type: ["string", "null"], enum: ["certain", "likely", "guessing", null] } }, required: ["text", "href", "tag"], additionalProperties: false } } }, required: ["title", "lines"], additionalProperties: false } },
  },
  required: ["headline", "sections"],
  additionalProperties: false,
};

/** Every call starting soon on the person's calendar, prepped once each (claimed by its event id) */
export async function prepUpcomingCalls(admin: Admin, me: Me, at?: string | null): Promise<number> {
  const { meetingsBetween } = await import("@/lib/routines");
  const now = Date.now();
  // Asked for a time ("prep me for my 2pm"): the call around then, today; else the ones starting in the next hour or so
  const center = at ? Date.parse(at) : NaN;
  const [from, to] = Number.isFinite(center) ? [center - 45 * 60_000, center + 45 * 60_000] : [now + PREP_FROM_MIN * 60_000, now + PREP_TO_MIN * 60_000];
  const meetings = await meetingsBetween(me.email, new Date(from).toISOString(), new Date(to).toISOString());
  const outside = (meetings ?? []).filter((m) => m.external.length > 0);
  if (!outside.length) return 0;
  const [{ data: clients }, { data: contacts }] = await Promise.all([
    admin.from("clients").select("id, name").is("archived_at", null).limit(1000),
    admin.from("contact_clients").select("client_id, contacts(email)").is("removed_at", null).limit(5000),
  ]);
  const { clientOfEvent } = await import("@/lib/integration-health/core");
  const emailsBy = new Map<string, string[]>();
  for (const r of contacts ?? []) {
    const e = String((r as unknown as { contacts: { email: string | null } | null }).contacts?.email ?? "").toLowerCase();
    if (e) emailsBy.set(r.client_id as string, [...(emailsBy.get(r.client_id as string) ?? []), e]);
  }
  const matches = (clients ?? []).map((c) => {
    const emails = emailsBy.get(c.id as string) ?? [];
    return { id: c.id as string, name: c.name as string, emails, domains: [...new Set(emails.map((e) => e.split("@")[1]).filter((d): d is string => Boolean(d) && !/^(gmail|googlemail|yahoo|hotmail|outlook|icloud|aol|live|msn|me|proton(mail)?)\./.test(`${d}.`)))] };
  });
  let made = 0;
  for (const m of outside.slice(0, 4)) {
    const key = `${me.id}|call_prep|event:${m.id}|${m.start.slice(0, 10)}${at ? `|asked:${Date.now()}` : ""}`;
    const { data: claimed, error } = await admin.from("routine_runs").insert({ profile_id: me.id, kind: "call_prep", run_key: key }).select("id").single();
    if (error || !claimed) continue;
    try {
      const client = clientOfEvent({ id: m.id, summary: m.title, start: m.start, attendees: m.external.map((email) => ({ email })) }, matches);
      // A sales call the Sales agent already briefs (src/lib/sales-briefs.ts): never a second brief or a second bell,
      // the run just points at that one
      if (!client) {
        const { data: sb } = await admin.from("sales_call_briefs").select("id, status, brief").eq("event_id", m.id).in("status", ["pending", "ready"]).limit(1).maybeSingle();
        if (sb) {
          const report: RoutineReport = { headline: sb.status === "ready" ? "The Sales agent's brief for this call is ready." : "The Sales agent is writing this call's brief.", sections: [{ title: "Sales call brief", lines: [{ text: "Open the brief", href: `/sales/briefs/${sb.id}`, tag: null }] }] };
          await admin.from("routine_runs").update({ status: "done", headline: report.headline, report, finished_at: new Date().toISOString() }).eq("id", claimed.id);
          continue;
        }
        // No client and no Sales brief (a vendor, a partner, a prospect the Sales agent hasn't picked up): no prep
        await admin.from("routine_runs").delete().eq("id", claimed.id);
        continue;
      }
      const report = await clientBrief(admin, me, m, client);
      await admin.from("routine_runs").update({ status: "done", headline: report.headline.slice(0, 400), report, finished_at: new Date().toISOString() }).eq("id", claimed.id);
      const at = new Date(m.start).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" });
      await admin.from("notifications").upsert({ profile_id: me.id, kind: "recap", key: `routine:${claimed.id}`, title: `Call prep · ${m.title} at ${at}: ${report.headline.split(/(?<=[.!?])\s/)[0]}`.slice(0, 200), body: report.sections.map((s) => s.title).join(" · ").slice(0, 1000), href: "/today", priority: "normal" }, { onConflict: "profile_id,key", ignoreDuplicates: true });
      made++;
    } catch (e) {
      await admin.from("routine_runs").update({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 1000), finished_at: new Date().toISOString() }).eq("id", claimed.id);
    }
  }
  return made;
}

type M = { id: string; title: string; start: string; external: string[]; link: string | null; agenda: boolean };

async function clientBrief(admin: Admin, me: Me, m: M, client: { id: string; name: string }): Promise<RoutineReport> {
  const [ctx, health, { data: owed }, { data: promises }, { data: said }] = await Promise.all([
    clientContext(admin, client.id, { fresh: true }).catch(() => null),
    import("@/lib/integration-health/load").then((x) => x.integrationHealth(admin, { clientIds: [client.id] })).catch(() => []),
    admin.from("call_commitments").select("what, due_at, status").eq("client_id", client.id).in("status", ["open", "briefed", "in_motion"]).limit(30),
    admin.from("message_promises").select("what, due_at, status").eq("client_id", client.id).in("status", ["open", "overdue", "escalated", "in_motion"]).limit(30),
    admin.from("context_items").select("source, occurred_at, author, body").eq("client_id", client.id).in("source", ["slack_external", "gmail", "call"]).order("occurred_at", { ascending: false }).limit(20),
  ]);
  const { isProblem } = await import("@/lib/integration-health/core");
  const down = (health[0]?.items ?? []).filter(isProblem);
  const out = await askJson<RoutineReport>({
    agent: "calls",
    label: "routine call prep",
    clientId: client.id,
    override: { model: "sonnet", effort: "low" },
    maxTokens: 2500,
    system: `You prep a ${me.role.replace(/_/g, " ")} at Kaizen, a paid ads, creative, email and social agency, for a client call in about an hour. Sections: "Goal" (one line), "What we owe" (each, and whether it's done), "What they owe", "Top risk" (with numbers), "Talking points" (2-3 points or questions), "Before the call" (anything to do or send first${down.length ? "; start with the connections that are down" : ""}), and "Heads-up" only if the meeting has no agenda or no video link. Never state what Kaizen charges the client. Tag inferred claims likely or guessing. Short lines. ${PEOPLE_RULE}`,
    schema: BRIEF,
    prompt: [
      ctx ? contextBlock(ctx, undefined, { allotment: false }) : `<client>${client.name}</client>`,
      `<meeting>${m.title} at ${m.start}; guests ${m.external.join(", ")}; ${m.agenda ? "has an agenda" : "no agenda"}; ${m.link ? "video link set" : "no video link"}</meeting>`,
      `<we_owe>${JSON.stringify([...(owed ?? []), ...(promises ?? [])])}</we_owe>`,
      down.length ? `<connections_down>${down.map((d) => `${d.label}: ${d.detail}`).join("; ")}</connections_down>` : "",
      said?.length ? `<said_lately>${said.map((s) => `[${String(s.occurred_at).slice(0, 10)} ${s.source}] ${String(s.body ?? "").replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}</said_lately>` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });
  return { headline: out.headline, sections: out.sections.filter((s) => s.lines.length) };
}
