import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyFindings, type Finding } from "@/lib/account-watch/run";
import { clientOfEvent, isProblem, KIND_LABEL, type CalEvent, type ClientMatch } from "./core";
import { integrationHealth } from "./load";

// The afternoon before a client call (owner, Nov 24 2026): around 3pm New York, read the next business day's Google
// Calendar of everyone who runs accounts (the execs, the line heads and the seat holders), find each call with a
// client, check every connection that call relies on, and flag anything disconnected, erroring or stale to the
// account's owner, their lead and whoever has the call: one Overview item per client with the fix link, so it's fixed
// before the call. It closes on its own once the call day has passed.

const nyDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const LINE_SEATS: Record<string, string[]> = { meta: ["meta_buyer", "tiktok_buyer"], tiktok: ["tiktok_buyer", "meta_buyer"], google: ["google_buyer"], klaviyo: ["email_strategist"], brevo: ["email_strategist"], customerio: ["email_strategist"], shopify: ["meta_buyer", "google_buyer", "email_strategist"], crm: ["meta_buyer", "google_buyer"], motion: ["meta_buyer"] };
const LINE_HEAD: Record<string, string> = { meta: "head_of_meta", tiktok: "head_of_meta", google: "head_of_google", klaviyo: "head_of_email", brevo: "head_of_email", customerio: "head_of_email", shopify: "head_of_meta", crm: "head_of_meta", motion: "head_of_meta" };

/** The next business day (New York): Friday looks at Monday */
export function nextBusinessDay(today: string): string {
  const d = new Date(`${today}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

export async function runPrecallCheck(admin: SupabaseClient, now = new Date()) {
  const today = nyDay(now);
  const day = nextBusinessDay(today);
  const [{ data: people }, { data: seats }, { data: clients }, { data: contacts }] = await Promise.all([
    admin.from("profiles").select("id, full_name, email, role, is_exec, is_active").eq("is_active", true),
    admin.from("client_assignments").select("client_id, profile_id, role, is_primary"),
    admin.from("clients").select("id, name, slug").is("archived_at", null).in("status", ["active", "onboarding"]),
    admin.from("contact_clients").select("client_id, contacts(email)").is("removed_at", null).limit(5000),
  ]);
  const team = (people ?? []) as { id: string; full_name: string; email: string | null; role: string; is_exec: boolean | null }[];
  const seatIds = new Set((seats ?? []).map((s) => s.profile_id as string));
  const whose = team.filter((p) => p.email && (p.is_exec || /^head_of_/.test(p.role) || seatIds.has(p.id)));
  const emailsBy = new Map<string, string[]>();
  for (const r of contacts ?? []) {
    const e = String((r as unknown as { contacts: { email: string | null } | null }).contacts?.email ?? "").toLowerCase();
    if (e) emailsBy.set(r.client_id as string, [...(emailsBy.get(r.client_id as string) ?? []), e]);
  }
  const matches: ClientMatch[] = ((clients ?? []) as { id: string; name: string }[]).map((c) => {
    const emails = emailsBy.get(c.id) ?? [];
    return { id: c.id, name: c.name, emails, domains: [...new Set(emails.map((e) => e.split("@")[1]).filter((d): d is string => Boolean(d) && !/^(gmail|googlemail|yahoo|hotmail|outlook|icloud|aol|live|msn|me|proton(mail)?)\./.test(`${d}.`)))] };
  });

  // Tomorrow's calls, from each person's own calendar (read only, through the Workspace's domain-wide delegation)
  const { googleCalendarToken, google } = await import("@/lib/context/google");
  const from = new Date(`${day}T05:00:00Z`).toISOString();
  const to = new Date(Date.parse(from) + 24 * 3_600_000).toISOString();
  const calls = new Map<string, { client: ClientMatch; people: Set<string>; titles: Set<string>; at: string | null }>();
  let read = 0;
  const failed: string[] = [];
  for (const p of whose) {
    try {
      const token = await googleCalendarToken(p.email!);
      const res = await google<{ items?: CalEvent[] }>(token, "https://www.googleapis.com/calendar/v3/calendars/primary/events", { timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "100" });
      read++;
      for (const ev of res.items ?? []) {
        const c = clientOfEvent({ ...ev, start: (ev.start as unknown as { dateTime?: string } | null)?.dateTime ?? null }, matches);
        if (!c) continue;
        const cur = calls.get(c.id) ?? { client: c, people: new Set<string>(), titles: new Set<string>(), at: null };
        cur.people.add(p.id);
        if (ev.summary) cur.titles.add(ev.summary);
        const at = (ev.start as unknown as { dateTime?: string } | null)?.dateTime ?? null;
        if (at && (!cur.at || at < cur.at)) cur.at = at;
        calls.set(c.id, cur);
      }
    } catch (e) {
      failed.push(`${p.full_name}: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
    }
  }

  const health = calls.size ? await integrationHealth(admin, { clientIds: [...calls.keys()] }, now) : [];
  const slug = new Map(((clients ?? []) as { id: string; slug: string }[]).map((c) => [c.id, c.slug]));
  const heads = (role: string) => team.filter((p) => p.role === role).map((p) => p.id);
  const findings: Finding[] = [];
  for (const h of health) {
    const bad = h.items.filter(isProblem);
    if (!bad.length) continue;
    const call = calls.get(h.clientId)!;
    const owners = new Set<string>(call.people);
    for (const b of bad) {
      for (const s of (seats ?? []).filter((x) => x.client_id === h.clientId && (LINE_SEATS[b.kind] ?? []).includes(x.role as string))) owners.add(s.profile_id as string);
      for (const id of heads(LINE_HEAD[b.kind] ?? "")) owners.add(id);
    }
    const when = call.at ? new Date(call.at).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) : new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    findings.push({
      key: `precall_sync:${h.clientId}:${day}`,
      kind: "precall_sync",
      client_id: h.clientId,
      line: null,
      account: null,
      title: `Call ${when}: fix ${bad.map((b) => KIND_LABEL[b.kind]).filter((x, i, a) => a.indexOf(x) === i).join(", ")} before it`,
      body: `${[...call.titles].slice(0, 1).join("")}${call.titles.size ? ". " : ""}${bad.map((b) => b.detail).join("; ")}. Reconnect or re-sync it today so the numbers are right on the call.`,
      detail: { day, at: call.at, problems: bad },
      severity: bad.some((b) => b.state === "disconnected" || b.state === "error") ? "critical" : "warn",
      href: `/clients/${slug.get(h.clientId) ?? ""}?tab=team#connections`,
      to: [...owners],
    });
  }
  const named = ((clients ?? []) as { id: string; name: string }[]).map((c) => ({ id: c.id, name: c.name, services: null, services_extra: null, services_removed: null, billed_services: null }));
  const applied = await applyFindings(admin, findings, named, new Map(), now, { owns: (k) => k === "precall_sync", noticeSuffix: ":dog" });
  return { day, calendars: read, unreadable: failed.length, failed: failed.slice(0, 5), calls: calls.size, flagged: findings.length, ...applied };
}
