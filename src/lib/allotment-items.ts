import "server-only";
import { createClient as createSupabase, type SupabaseClient } from "@supabase/supabase-js";
import { allotmentBucket, allotmentTitle } from "@/lib/ops-items-core";

// Hours over allotment (owner, Nov 27 2026: an exec's Claude runs flagged Kore's and Sierra Dreams' Meta media-buyer
// hours past their November allotment going into BFCM; the OS didn't). Kaizen Track already records when a team's
// hours on a client cross 80%, 100%, 125%… of the month's allotment (allotment_alerts). Each crossing becomes one item
// for the team's leaders and its exec owner, with hours used and who logged them: one at ~80%, one at 100%+ (updated as
// it climbs). Deduped per client, team and month.

type Admin = SupabaseClient;
const trackDb = () => (process.env.TRACK_SUPABASE_URL && process.env.TRACK_SUPABASE_SECRET_KEY ? createSupabase(process.env.TRACK_SUPABASE_URL, process.env.TRACK_SUPABASE_SECRET_KEY, { auth: { persistSession: false } }) : null);

export async function allotmentItems(admin: Admin) {
  const track = trackDb();
  if (!track) return { skipped: "Kaizen Track isn't connected" };
  const nyToday = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const month = `${nyToday.slice(0, 7)}-01`;
  const { data: alerts } = await track.from("allotment_alerts").select("team_id, client_id, level, sent_at").eq("month", month).gte("level", 80).limit(5000);
  if (!alerts?.length) return { made: 0, updated: 0 };
  const top = new Map<string, { team: string; client: string; level: number }>();
  for (const a of alerts) {
    const k = `${a.client_id}|${a.team_id}`;
    if ((top.get(k)?.level ?? 0) < Number(a.level)) top.set(k, { team: a.team_id as string, client: a.client_id as string, level: Number(a.level) });
  }
  const teamIds = [...new Set([...top.values()].map((t) => t.team))];
  const clientIds = [...new Set([...top.values()].map((t) => t.client))];
  const [{ data: teams }, { data: members }, { data: tprofiles }, { data: projects }, { data: allot }, { data: osClients }, { data: osPeople }] = await Promise.all([
    track.from("teams").select("id, name, area, role_label, exec_owner_id").in("id", teamIds),
    track.from("team_members").select("team_id, profile_id, is_leader").in("team_id", teamIds),
    track.from("profiles").select("id, email, full_name"),
    track.from("projects").select("id, client_id").in("client_id", clientIds),
    track.from("team_allotments").select("team_id, client_id, monthly_hours").in("client_id", clientIds),
    admin.from("clients").select("id, name, track_client_id").not("track_client_id", "is", null),
    admin.from("profiles").select("id, email, full_name").eq("is_active", true),
  ]);
  const projectIds = (projects ?? []).map((p) => p.id as string);
  const { data: entries } = projectIds.length
    ? await track.from("time_entries").select("profile_id, project_id, duration_s").in("project_id", projectIds).is("deleted_at", null).neq("status", "rejected").gte("started_at", `${month}T05:00:00Z`).limit(20000)
    : { data: [] };
  const emailOf = new Map((tprofiles ?? []).map((p) => [p.id as string, String(p.email ?? "").toLowerCase()]));
  const nameOf = new Map((tprofiles ?? []).map((p) => [p.id as string, String(p.full_name ?? "someone")]));
  const osByEmail = new Map((osPeople ?? []).map((p) => [String(p.email ?? "").toLowerCase(), p.id as string]));
  const osClientOf = new Map((osClients ?? []).map((c) => [c.track_client_id as string, { id: c.id as string, name: c.name as string }]));
  const clientOfProject = new Map((projects ?? []).map((p) => [p.id as string, p.client_id as string]));
  let made = 0;
  let updated = 0;
  for (const t of top.values()) {
    const team = (teams ?? []).find((x) => x.id === t.team);
    const client = osClientOf.get(t.client) ?? null;
    if (!team || !client) continue;
    const mem = (members ?? []).filter((m) => m.team_id === t.team);
    const memberIds = new Set(mem.map((m) => m.profile_id as string));
    // Hours this month on the client by the team's members, by person
    const byPerson = new Map<string, number>();
    for (const e of entries ?? []) if (clientOfProject.get(e.project_id as string) === t.client && memberIds.has(e.profile_id as string)) byPerson.set(e.profile_id as string, (byPerson.get(e.profile_id as string) ?? 0) + Number(e.duration_s ?? 0) / 3600);
    const used = [...byPerson.values()].reduce((a, b) => a + b, 0);
    const allotted = Number((allot ?? []).find((a) => a.team_id === t.team && a.client_id === t.client)?.monthly_hours ?? 0) || null;
    const owners = [...new Set([...mem.filter((m) => m.is_leader).map((m) => m.profile_id as string), ...(team.exec_owner_id ? [team.exec_owner_id as string] : [])].map((id) => osByEmail.get(emailOf.get(id) ?? "")).filter((x): x is string => Boolean(x)))];
    if (!owners.length) continue;
    const bucket = allotmentBucket(t.level);
    const title = allotmentTitle({ client: client.name, team: String(team.name), level: t.level, month: nyToday.slice(0, 7) });
    const who = [...byPerson].sort((a, b) => b[1] - a[1]).map(([id, h]) => `${nameOf.get(id) ?? "someone"} ${h.toFixed(1)}h`).join(", ");
    const detail = `${team.name} on ${client.name}: ${used.toFixed(1)}h logged this month${allotted ? ` against ${allotted}h allotted` : ""}, past ${t.level}% of the allotment (Kaizen Track).\nWho logged it: ${who || "no entries found"}.\nDecide: ask for more hours (an allotment request in Track, or a change order with the client) or hold new work on this line until next month.\n(Created by Kaizen OS from Kaizen Track's allotment alerts.)`;
    for (const owner of owners) {
      const ref = `allot:${client.id}:${t.team}:${month}:${bucket}:${owner}`;
      const { data: have } = await admin.from("agent_asks").select("id, status, title").eq("source_ref", ref).limit(1).maybeSingle();
      if (have) {
        if (have.status === "open" && have.title !== title) {
          await admin.from("agent_asks").update({ title, detail }).eq("id", have.id);
          updated++;
        }
        continue;
      }
      const { error } = await admin.from("agent_asks").insert({ kind: "task", owner_id: owner, asked_by: owner, client_id: client.id, title, detail, due_on: nyToday, urgent: bucket === "100", source_ref: ref });
      if (!error) made++;
    }
  }
  return { made, updated };
}
