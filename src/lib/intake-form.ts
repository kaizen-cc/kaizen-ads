import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient as createSupabase } from "@supabase/supabase-js";
import { askJson, clientContext, contextBlock } from "@/lib/ai";
import { bankFor, CALLS, modelFor, type BusinessModel, type CallType, type IntakeForm, type IntakeQuestion } from "@/lib/intake-questions";
import { accessLeft, callType } from "@/lib/onboarding-guide-types";
import { servicesOf, SERVICES } from "@/lib/services";
import { siteUrl } from "@/lib/site";

// The marketing intake in the client's portal, right after their access steps: the questions tailored to them (their
// services, how they sell, their industry; what we already know filled in for them to confirm), saved as they go, and
// sent through exactly the path the old Google Form took (kept as answered, read by the AI, the Bible written from it).
// Then the team hears it: the internal Slack channel, Kaizen Ads for the Meta and creative people, and an Asana task in
// the client's own Asana project for everyone else on the account (from the Account Overview sheet; they aren't in
// Kaizen Ads yet). Last, the onboarding call: done-for-you when
// setup hit a wall or two or more access steps are still open, otherwise done-with-you.

export type IntakeFormRow = {
  form: IntakeForm | null;
  answers: Record<string, string>;
  status: "new" | "preparing" | "ready" | "submitted" | "failed";
  submitted_at: string | null;
  call_type: CallType | null;
  call_reason: string | null;
  computer: string | null;
  call_booked_at: string | null;
};

export async function loadIntakeForm(admin: SupabaseClient, clientId: string): Promise<IntakeFormRow | null> {
  const { data } = await admin.from("client_intake_forms").select("form, answers, status, submitted_at, call_type, call_reason, computer, call_booked_at, updated_at").eq("client_id", clientId).maybeSingle();
  if (!data) return null;
  return { ...data, answers: (data.answers ?? {}) as Record<string, string> } as IntakeFormRow;
}

const TAILOR_SCHEMA = {
  type: "object",
  properties: {
    model: { type: "string", enum: ["ecommerce", "local", "leadgen", "other"] },
    industry: { type: "string" },
    rewrite: { type: "array", items: { type: "object", properties: { id: { type: "string" }, q: { type: "string" }, help: { type: "string" } }, required: ["id", "q", "help"], additionalProperties: false } },
    drop: { type: "array", items: { type: "string" } },
    prefill: { type: "array", items: { type: "object", properties: { id: { type: "string" }, value: { type: "string" } }, required: ["id", "value"], additionalProperties: false } },
    extra: { type: "array", items: { type: "object", properties: { q: { type: "string" }, help: { type: "string" }, kind: { type: "string", enum: ["long", "short"] } }, required: ["q", "help", "kind"], additionalProperties: false } },
  },
  required: ["model", "industry", "rewrite", "drop", "prefill", "extra"],
  additionalProperties: false,
};
type Tailored = { model: BusinessModel; industry: string; rewrite: { id: string; q: string; help: string }[]; drop: string[]; prefill: { id: string; value: string }[]; extra: { q: string; help: string; kind: "long" | "short" }[] };

const describe = (q: IntakeQuestion) => `${q.id} [${q.section}${q.required ? ", required" : ""}] (${q.kind}${q.options ? `: ${q.options.join(" | ")}` : ""}) ${q.q}`;

/**
 * The client's questions: our bank for their services and how they sell, picked and reworded for their industry, with
 * up to five questions only their kind of business needs and what we already know (calls, emails, Slack, the Bible
 * draft) filled in. Written once and kept; the bank alone if the AI can't be reached, so the form always opens.
 */
export async function prepareIntakeForm(admin: SupabaseClient, clientId: string, force = false): Promise<IntakeFormRow> {
  const existing = await loadIntakeForm(admin, clientId);
  if (existing?.form && !force && existing.status !== "failed") return existing;
  const { data: c } = await admin.from("clients").select("name, industry, industry_detail, services, services_extra, services_removed").eq("id", clientId).single();
  if (!c) throw new Error("Client not found");
  const services = servicesOf(c);
  const startModel = modelFor(c.industry as string | null);
  await admin.from("client_intake_forms").upsert({ client_id: clientId, status: "preparing", error: null, updated_at: new Date().toISOString() });
  let form = bankFor(services, startModel);
  let error: string | null = null;
  try {
    const ctx = await clientContext(admin, clientId);
    const known = ctx ? contextBlock(ctx).slice(0, 40000) : "";
    const out = await askJson<Tailored>({
      agent: "strategist",
      label: `intake questions ${c.name}`,
      bare: true,
      override: { model: "sonnet", effort: "low" },
      maxTokens: 8000,
      system: `You tailor a new client's marketing intake form for a performance marketing agency. The form fills the gaps in what the team needs to know to run their ads and creative well, for the services they bought. Keep it short and specific to their business; never ask what we already know: fill it in instead, for them to confirm.
- model: how they sell. ecommerce (they ship products ordered online), local (people visit, book or order from a place: restaurants, gyms, salons, spas), leadgen (calls and forms turn into quotes or appointments: home services, dental, legal, B2B), other.
- industry: two to four words for their business ("Pizza restaurant", "Roofing contractor").
- rewrite: bank questions worth rewording so they read naturally for this business (a restaurant's "best sellers" are dishes; a roofer's "first purchase" is a job). Keep the meaning, the plain warm tone, and short. help is one short line or "".
- drop: bank question ids that don't fit this business or are already fully answered by what we know. Never drop a required one; fill it in instead.
- prefill: answers we already know from the context, in their words where possible, for any question id. For a question with options, the value must be one of its options exactly (several joined by "; " where more than one can be picked). Only what the context really says; nothing guessed.
- extra: up to five questions only this kind of business needs and the bank doesn't ask (a restaurant: catering, private events, delivery apps, signature dishes; a dentist: the treatments with the best margins, insurance; ecommerce: subscriptions, bundles). Don't repeat the bank.`,
      schema: TAILOR_SCHEMA,
      prompt: [
        `<client>${c.name}${c.industry_detail ? ` (${c.industry_detail})` : ""}</client>`,
        `<services_bought>${services.map((s) => SERVICES.find((x) => x.slug === s)?.label ?? s).join(", ") || "none listed"}</services_bought>`,
        `<model_guess>${startModel}</model_guess>`,
        `<question_bank>\n${form.questions.map(describe).join("\n")}\n</question_bank>`,
        known ? `<what_we_know>\n${known}\n</what_we_know>` : "<what_we_know>Nothing yet beyond the name.</what_we_know>",
      ].join("\n\n"),
    });
    // How they sell decides a set of questions: rebuild the bank if the AI read it differently
    if (out.model !== startModel) form = bankFor(services, out.model);
    form = tailor(form, out);
  } catch (e) {
    error = e instanceof Error ? e.message.slice(0, 300) : String(e);
  }
  const now = new Date().toISOString();
  await admin.from("client_intake_forms").upsert({ client_id: clientId, form, status: "ready", error, prepared_at: now, updated_at: now });
  return { form, answers: existing?.answers ?? {}, status: "ready", submitted_at: null, call_type: existing?.call_type ?? null, call_reason: existing?.call_reason ?? null, computer: existing?.computer ?? null, call_booked_at: existing?.call_booked_at ?? null };
}

function tailor(form: IntakeForm, out: Tailored): IntakeForm {
  const drop = new Set(out.drop);
  const questions = form.questions
    .filter((q) => q.required || !drop.has(q.id))
    .map((q) => {
      const r = out.rewrite.find((x) => x.id === q.id);
      const p = out.prefill.find((x) => x.id === q.id)?.value?.trim();
      const next: IntakeQuestion = r?.q.trim() ? { ...q, q: r.q.trim().slice(0, 200), help: r.help.trim() ? r.help.trim().slice(0, 240) : q.help } : { ...q };
      if (p) {
        // A pick has to be one of the options (several for "many"); anything else is dropped rather than shown wrong
        if (q.kind === "one") next.prefill = q.options?.includes(p) ? p : null;
        else if (q.kind === "many") next.prefill = p.split(";").map((x) => x.trim()).filter((x) => q.options?.includes(x)).join("; ") || null;
        else next.prefill = p.slice(0, 2000);
      }
      return next;
    });
  // Their industry's own questions go before the last screen
  const extra: IntakeQuestion[] = out.extra.slice(0, 5).map((x, i) => ({ id: `x${i + 1}`, section: "industry", q: x.q.trim().slice(0, 200), help: x.help.trim().slice(0, 240) || undefined, kind: x.kind }));
  const at = questions.findIndex((q) => q.section === "last");
  questions.splice(at < 0 ? questions.length : at, 0, ...extra);
  return { ...form, model: out.model, industry: out.industry.trim().slice(0, 80) || null, questions };
}

export async function saveIntakeAnswers(admin: SupabaseClient, clientId: string, answers: Record<string, string>) {
  const row = await loadIntakeForm(admin, clientId);
  if (!row?.form) return { ok: false as const, error: "The form isn't ready yet." };
  if (row.status === "submitted") return { ok: false as const, error: "Already sent: thank you!" };
  const ids = new Set(row.form.questions.map((q) => q.id));
  const clean = Object.fromEntries(Object.entries(answers).filter(([k, v]) => ids.has(k) && typeof v === "string").map(([k, v]) => [k, v.slice(0, 4000)]));
  const now = new Date().toISOString();
  await admin.from("client_intake_forms").update({ answers: { ...row.answers, ...clean }, started_at: row.answers && Object.keys(row.answers).length ? undefined : now, updated_at: now }).eq("client_id", clientId);
  return { ok: true as const };
}

/** What a question's answer is: theirs, or what we'd filled in and they left as it was */
export const answerOf = (q: IntakeQuestion, answers: Record<string, string>) => (q.id in answers ? answers[q.id] : (q.prefill ?? "")).trim();

const ITEM_NAMES: Record<string, string> = { meta: "Facebook and Instagram access", google: "Google Ads access", ga4: "Google Analytics", gtm: "Google Tag Manager", gbp: "your Google Business Profile", merchant: "Merchant Center", website: "your website", email: "your email platform", tracking: "where your orders or leads live" };

/** Which onboarding call they get: done-for-you when setup hit a wall or two or more access items are open */
export async function callTypeFor(admin: SupabaseClient, clientId: string): Promise<{ type: CallType; reason: string; left: string[] }> {
  const { guideHas, loadGuide } = await import("@/lib/onboarding-guide");
  const [has, guide, { data: o }] = await Promise.all([guideHas(admin, clientId), loadGuide(admin, clientId), admin.from("client_onboarding").select("blockers").eq("client_id", clientId).maybeSingle()]);
  const blockers = ((o?.blockers ?? []) as { kind: string }[]).filter(Boolean);
  const a = accessLeft(guide, has, blockers);
  const left = a.items.map((k) => ITEM_NAMES[k] ?? k.replaceAll("_", " "));
  const type = callType(a);
  if (type === "dfy" && a.blocker) {
    const { BLOCKER_NAMES } = await import("@/lib/call-prep");
    return { type, reason: `You ran into ${(BLOCKER_NAMES[blockers[0].kind] ?? "a snag").toLowerCase()} while setting up, so we'll sort it out together and do the clicking for you.`, left };
  }
  if (type === "dfy") return { type, reason: `${left.slice(0, -1).join(", ")} and ${left[left.length - 1]} are still to share. Easiest is to let us do them for you while you share your screen.`, left };
  return { type, reason: left.length ? `Almost everything's shared (just ${left[0]} left), so this is a quicker call to finish it and walk through your plan together.` : "Your access is all in, so this is a quicker call to walk through your plan together.", left };
}

/**
 * Their answers sent: kept exactly as the Google Form's were (same row, same reading, the Bible built from it), then
 * the team is told. The Google Form's path stays open for old links.
 */
export async function submitIntakeForm(admin: SupabaseClient, clientId: string, by: string) {
  const row = await loadIntakeForm(admin, clientId);
  if (!row?.form) return { ok: false as const, error: "The form isn't ready yet." };
  if (row.status === "submitted") return { ok: true as const, intakeId: null };
  const missing = row.form.questions.filter((q) => q.required && !answerOf(q, row.answers));
  if (missing.length) return { ok: false as const, error: `A few still need an answer: ${missing.slice(0, 3).map((q) => `"${q.q}"`).join(", ")}${missing.length > 3 ? "…" : ""}`, missing: missing.map((q) => q.id) };
  const { data: c } = await admin.from("clients").select("name, kaizen_id").eq("id", clientId).single();
  // The same shape Zapier sends: every question as asked, with the Client ID and business name to match it
  const raw: Record<string, string> = { "Client ID": c?.kaizen_id != null ? String(c.kaizen_id) : "", "Business name": (c?.name as string) ?? "", Source: "Kaizen portal intake" };
  for (const q of row.form.questions) {
    const a = answerOf(q, row.answers);
    if (a) raw[q.q] = a;
  }
  const { receiveIntake } = await import("@/lib/onboarding");
  const r = await receiveIntake(admin, raw);
  // Matched by the Client ID; if that's missing, by name. Either way it's this client's
  if (!r.clientId) await admin.from("client_intakes").update({ client_id: clientId, status: "received" }).eq("id", r.id);
  const now = new Date().toISOString();
  await admin.from("client_intake_forms").update({ status: "submitted", submitted_at: now, submitted_by: by, intake_id: r.id, updated_at: now }).eq("client_id", clientId);
  return { ok: true as const, intakeId: r.duplicate ? null : r.id };
}

/** After it's sent: read it like any intake, and tell the team (Slack, Kaizen Ads, Asana for the teams not in it yet) */
export async function afterIntakeSubmitted(admin: SupabaseClient, clientId: string, intakeId: string) {
  const { processIntake } = await import("@/lib/onboarding");
  await processIntake(admin, intakeId).catch((e) => console.error("[intake] read", e));
  await tellTeamIntake(admin, clientId).catch((e) => console.error("[intake] tell team", e));
}

/** Services the Meta and creative people cover: they review the intake in Kaizen Ads; every other team gets Asana */
const IN_KAIZEN_ADS = new Set(["facebook-ads", "tiktok-ads", "creative"]);

async function tellTeamIntake(admin: SupabaseClient, clientId: string) {
  const [{ data: c }, row] = await Promise.all([
    admin.from("clients").select("name, slug, kaizen_id, asana_project_gid, internal_slack_channel_id, services, services_extra, services_removed").eq("id", clientId).single(),
    loadIntakeForm(admin, clientId),
  ]);
  if (!c || !row?.form) return;
  const link = `${siteUrl()}/clients/${c.slug}`;
  const lines = row.form.questions.map((q) => [q, answerOf(q, row.answers)] as const).filter(([, a]) => a);
  const summary = lines.map(([q, a]) => `${q.q}\n${a}`).join("\n\n");

  // The internal channel
  if (c.internal_slack_channel_id && process.env.SLACK_BOT_TOKEN)
    await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel: c.internal_slack_channel_id, text: `📋 ${c.name} filled in their marketing intake in their portal (${lines.length} answers). Review it: ${link}`, unfurl_links: false }),
    }).catch(() => null);

  // Meta and creative: in Kaizen Ads
  const { data: assigned } = await admin.from("client_assignments").select("profile_id").eq("client_id", clientId).in("role", ["meta_buyer", "graphic_designer", "video_editor", "copywriter"]);
  const ids = [...new Set((assigned ?? []).map((a) => a.profile_id as string))];
  if (ids.length)
    await admin.from("notifications").upsert(
      ids.map((id) => ({ profile_id: id, kind: "onboarding", title: `${c.name}: their marketing intake is in`, body: "Read their answers before the first round: what they sell, who buys, the offer to lead with and what a win looks like.", href: `/clients/${c.slug}`, client_id: clientId, key: `intake-in:${clientId}`, priority: "normal" })),
      { onConflict: "profile_id,key", ignoreDuplicates: true },
    );

  // Everyone else on the account: an Asana task each, in the client's own Asana project
  const { asanaConfigured, createAsanaTask, findClientProject } = await import("@/lib/asana");
  if (!asanaConfigured()) {
    await admin.from("client_intake_forms").update({ asana_tasks: { skipped: "ASANA_TOKEN not set" } }).eq("client_id", clientId);
    return;
  }
  const people = await accountTeam(admin, { name: c.name as string, kaizenId: (c.kaizen_id as number | null) ?? null, services: servicesOf(c) });
  if (!people.size) {
    await admin.from("client_intake_forms").update({ asana_tasks: { skipped: "Nobody outside Meta and creative found on the account (Account Overview sheet, Kaizen Track teams)" } }).eq("client_id", clientId);
    return;
  }
  // The client's own project (its title has their name and Client ID), found once and kept on the client
  let project = (c.asana_project_gid as string | null) ?? null;
  let projectNote: string | null = null;
  if (!project) {
    const found = await findClientProject((c.kaizen_id as number | null) ?? null, c.name as string).catch(() => null);
    if (found) {
      project = found.gid;
      await admin.from("clients").update({ asana_project_gid: found.gid }).eq("id", clientId);
    } else {
      const { data: setting } = await admin.from("app_settings").select("value").eq("key", "asana_intake").maybeSingle();
      project = ((setting?.value ?? {}) as { projectGid?: string }).projectGid?.trim() || process.env.ASANA_PROJECT_GID || null;
      projectNote = `No Asana project with ${c.name}'s name or Client ID ${c.kaizen_id ?? "(none)"} was found${project ? ", so the tasks went to the fallback project" : ", so the tasks are in each person's My Tasks"}.`;
      const { tellGuideTeam } = await import("@/lib/onboarding-guide");
      await tellGuideTeam(admin, clientId, "has no Asana project we could find", `${projectNote} Name their project with the client's name and Client ID, or set it on the client.`, `asana-project:${clientId}`, "normal");
    }
  }
  const due = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const made: { email: string; teams: string[]; url: string | null; error?: string }[] = [];
  for (const [email, teamNames] of people) {
    try {
      const t = await createAsanaTask({
        name: `Review ${c.name}'s marketing intake`,
        notes: `${c.name} filled in their marketing intake in their Kaizen portal. Review what matters for your part (${teamNames.join(", ")}) before kickoff.\n\nIn Kaizen Ads: ${link}\n\n— Their answers —\n\n${summary}`,
        assignee: email,
        project,
        dueOn: due,
      });
      made.push({ email, teams: teamNames, url: t.url });
    } catch (e) {
      made.push({ email, teams: teamNames, url: null, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    }
  }
  await admin.from("client_intake_forms").update({ asana_tasks: { made, project, projectNote } }).eq("client_id", clientId);
}

/** A role the Meta and creative people hold: they review in Kaizen Ads, not Asana */
const IN_APP_ROLE = /meta|facebook|instagram|tiktok|graphic|designer|video|editor|copy|creative/i;

/**
 * The people on an account outside Meta and creative, by email (with what they do there): every person the Account
 * Overview sheet names on the client's row (the Google tab's buyer, CS, email, web…), matched to the team by name.
 * A service nobody there covers falls back to the lead of the Kaizen Track team that does it.
 */
async function accountTeam(admin: SupabaseClient, c: { name: string; kaizenId: number | null; services: string[] }) {
  const people = new Map<string, string[]>(); // email → what they do on the account
  const add = (email: string, what: string) => people.set(email.toLowerCase(), [...new Set([...(people.get(email.toLowerCase()) ?? []), what])]);
  const track = process.env.TRACK_SUPABASE_URL && process.env.TRACK_SUPABASE_SECRET_KEY ? createSupabase(process.env.TRACK_SUPABASE_URL, process.env.TRACK_SUPABASE_SECRET_KEY, { auth: { persistSession: false } }) : null;
  // Everyone at Kaizen by name: Track has every team, Kaizen Ads the ones already in it
  const [{ data: ours }, theirs] = await Promise.all([
    admin.from("profiles").select("full_name, email").eq("is_active", true),
    track ? track.from("profiles").select("full_name, email").eq("is_active", true).then((r) => r.data ?? []) : Promise.resolve([] as { full_name: string; email: string }[]),
  ]);
  const staff = [...(ours ?? []), ...theirs].filter((p) => p.email && p.full_name) as { full_name: string; email: string }[];
  const n = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const emailOf = (who: string) => {
    const exact = staff.find((p) => n(p.full_name) === n(who));
    if (exact) return exact.email;
    // "Sultan" on the sheet: the one person with that first name
    const first = [...new Set(staff.filter((p) => n(p.full_name.split(" ")[0]) === n(who.split(" ")[0]) && (who.split(" ").length === 1 || n(p.full_name).startsWith(n(who)))).map((p) => p.email.toLowerCase()))];
    return first.length === 1 ? first[0] : null;
  };
  const { accountPeople } = await import("@/lib/account-sheet");
  const named = await accountPeople({ name: c.name, kaizenId: c.kaizenId }).catch(() => []);
  for (const p of named) {
    // The Meta tab's buyer is a Meta buyer; the Google tab's is Google
    const role = /buyer/i.test(p.role) && !/meta|google/i.test(p.role) ? `${p.tab} ${p.role}` : p.role;
    if (IN_APP_ROLE.test(role)) continue;
    const email = emailOf(p.person);
    if (email && !email.startsWith("tech@")) add(email, role);
  }
  // Services the sheet names nobody for: the Track team's lead (or everyone on a team without one)
  const others = c.services.filter((s) => !IN_KAIZEN_ADS.has(s));
  if (track && others.length) {
    const { data: teams } = await track.from("teams").select("name, team_services(services(slug)), team_members(is_leader, profiles(email, is_active))").eq("is_active", true);
    type T = { name: string; team_services: { services: { slug: string } | null }[]; team_members: { is_leader: boolean; profiles: { email: string; is_active: boolean } | null }[] };
    const covered = (slug: string) => [...people.values()].flat().some((r) => r.toLowerCase().includes(slug.split("-")[0]));
    for (const t of (teams ?? []) as unknown as T[]) {
      const slugs = t.team_services.map((s) => s.services?.slug).filter((s): s is string => Boolean(s && others.includes(s as (typeof others)[number])));
      if (!slugs.length || slugs.every(covered)) continue;
      const members = t.team_members.filter((m) => m.profiles?.is_active && m.profiles.email);
      for (const m of members.some((m) => m.is_leader) ? members.filter((m) => m.is_leader) : members) add(m.profiles!.email, t.name);
    }
  }
  return people;
}

export { CALLS };
