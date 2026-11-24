import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { mapAsanaFields, pickSection, purposeText, looseName, requestSection, type AsanaFieldSetting, type WantedField } from "@/lib/copy-docs/core";
import { approveCopyDoc, clientFacts, loadCopyDoc, type Me } from "@/lib/copy-docs/server";
import { applyPatch, followerOf, newRun, readAsk, tasksFor, type LineConfig, type Patch, type Request, type RunState } from "./engine";
import { lineOf } from "./lines";
import { slidesOfPost } from "./lines/social";

// The deliverable flow on the server: one run per call and line (kept on deliverable_runs, so every agent on the call
// and every turn reads the same state), the fresh context the lead reads before brainstorming, and the requests: the
// approved copy as a Google Doc in the client's HQ Drive, then the Asana task(s) in the line's project and column, with
// the fields filled by name, no assignee or due date (the strategists set those), the client's strategist on the line
// following, recorded on the copy and the line's Kaizen mirror. Fixes to a task (a field, the description, the column)
// are updates; nothing is ever deleted.

type Admin = SupabaseClient;
export type Run = { id: string; state: RunState; cfg: LineConfig };

const ID = /^[0-9a-f-]{36}$/i;

/** The open run on this call (the newest one not wrapped up), for one line or any */
export async function currentRun(admin: Admin, callId: string, line?: string | null): Promise<Run | null> {
  if (!ID.test(callId)) return null;
  let q = admin.from("deliverable_runs").select("id, line, state").eq("call_id", callId).eq("open", true);
  if (line) q = q.eq("line", line);
  const { data } = await q.order("updated_at", { ascending: false }).limit(1).maybeSingle();
  const cfg = lineOf(data?.line as string | undefined);
  return data && cfg ? { id: data.id as string, state: data.state as RunState, cfg } : null;
}

/** A new run (the type and count they already said are taken as answered) */
export async function startRun(admin: Admin, me: Me, callId: string, cfg: LineConfig, client: { id: string; name: string }, said: string): Promise<Run> {
  const open = await currentRun(admin, callId, cfg.line);
  if (open && open.state.client?.id === client.id) return open;
  if (open) await admin.from("deliverable_runs").update({ open: false }).eq("id", open.id);
  const asked = readAsk(cfg, said);
  let state = newRun(cfg.line, client);
  const pre = applyPatch(cfg, state, { kind: asked.kind, count: asked.kind ? asked.count : null });
  if (pre.ok) state = pre.state;
  const { data, error } = await admin.from("deliverable_runs").insert({ call_id: ID.test(callId) ? callId : null, profile_id: me.id, line: cfg.line, client_id: client.id, state }).select("id").single();
  if (error || !data) throw new Error("Couldn't start it on our side. Try again.");
  return { id: data.id as string, state, cfg };
}

export async function patchRun(admin: Admin, run: Run, patch: Patch): Promise<{ ok: true; run: Run } | { ok: false; why: string }> {
  const r = applyPatch(run.cfg, run.state, patch);
  if (!r.ok) return r;
  await admin
    .from("deliverable_runs")
    .update({ state: r.state, open: !r.state.wrapped, doc_id: r.state.docId, updated_at: new Date().toISOString() })
    .eq("id", run.id);
  return { ok: true, run: { ...run, state: r.state } };
}

/** A change to a run by its id (the document view's approvals and revisions reach the call's flow) */
export async function patchRunById(admin: Admin, id: string, patch: Patch) {
  const { data } = await admin.from("deliverable_runs").select("id, line, state").eq("id", id).maybeSingle();
  const cfg = lineOf(data?.line as string | undefined);
  if (!data || !cfg) return { ok: false as const, why: "No such run." };
  return patchRun(admin, { id, state: data.state as RunState, cfg }, patch);
}

/** May the writer join now (the topics agreed on this call's run for its line)? */
export async function writerMayJoin(admin: Admin, callId: string, role: string) {
  const run = await currentRun(admin, callId);
  if (!run || run.cfg.writer !== role) return false;
  return run.state.topicsAgreed && run.state.topics.length > 0;
}

// ─── Fresh context before brainstorming ────────────────────────────────────

/** What the lead reads before brainstorming: the account brief, what's pending (calls, open requests), the client's rules */
export async function freshContext(admin: Admin, cfg: LineConfig, clientId: string) {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const [brief, promises, tickets, mirror, notes, board] = await Promise.all([
    cfg.line === "email" ? import("@/lib/email-ops/chat").then((m) => m.emailBrief(admin, clientId)).catch(() => null) : Promise.resolve(null),
    admin.from("call_commitments").select("kind, what, due_at, status").eq("client_id", clientId).in("status", ["open", "briefed"]).gte("created_at", since).order("due_at").limit(15),
    cfg.line === "email" ? admin.from("email_tickets").select("number, kind, title, stage, due_on").eq("client_id", clientId).is("deleted_at", null).neq("stage", "live").limit(15) : Promise.resolve({ data: [] }),
    cfg.asana.mirror
      ? admin.from(cfg.asana.mirror).select("name, section, due_on").eq("client_id", clientId).eq("open", true).is("ticket_id", null).limit(15)
      : cfg.line === "creative"
        ? admin.from("asana_tasks").select("name, section, due_on").eq("client_id", clientId).eq("open", true).limit(15)
        : Promise.resolve({ data: [] }),
    admin.from("client_memory").select("kind, body, dated, created_at").eq("client_id", clientId).order("created_at", { ascending: false }).limit(12),
    // The line's KPI board as the board shows it (the email score with deliverability, pace, RPR, rates, the cycle, segments)
    cfg.line === "email" || cfg.line === "social" ? boardFor(admin, cfg.line, clientId) : Promise.resolve(null),
  ]);
  // Email: what the allotment leaves this cycle (the SOW's month during onboarding, else the package), so the plan fits it
  const allot = cfg.line === "email" ? await emailAllotmentFor(admin, clientId).catch(() => null) : null;
  return {
    kpi_board: board,
    ...(allot ? { email_allotment: allot } : {}),
    account: brief?.text?.slice(0, 14000) ?? null,
    promised_on_calls: (promises.data ?? []).map((p) => ({ kind: p.kind, what: p.what, due: String(p.due_at ?? "").slice(0, 10), status: p.status })),
    open_on_the_board: (tickets.data ?? []).map((t) => ({ number: t.number, kind: t.kind, title: t.title, stage: t.stage, due: t.due_on })),
    open_in_asana: (mirror.data ?? []).map((t) => ({ name: t.name, column: t.section, due: t.due_on })),
    client_memory: (notes.data ?? []).map((n) => ({ kind: n.kind, body: String(n.body ?? "").slice(0, 600), at: String(n.dated ?? n.created_at ?? "").slice(0, 10) })),
    also_read: cfg.context,
  };
}

/** The client's email allotment this cycle, in words, with the SOW month's notes */
async function emailAllotmentFor(admin: Admin, clientId: string) {
  const [{ emailAllotments }, { emailAllotmentLine }] = await Promise.all([import("@/lib/email-request"), import("@/lib/email-allotment-core")]);
  const a = (await emailAllotments(admin, [clientId]))[clientId];
  if (!a) return null;
  const month = a.cycle ? `${a.cycle.start.slice(0, 7)}-01` : null;
  const { data: m } = month ? await admin.from("email_scope_months").select("label, notes").eq("client_id", clientId).eq("month", month).maybeSingle() : { data: null };
  return { this_cycle: emailAllotmentLine(a) ?? "No allotment set", from: a.source, label: a.label, sow_month_notes: (m?.notes as string | null) ?? null, rule: "A flow counts once; a batch counts each campaign; delivered and in-motion requests both count." };
}

/** The KPI board's view of the client (read with the server's rights, as the lead's own tools already reach this client) */
async function boardFor(admin: Admin, line: "email" | "social", clientId: string) {
  try {
    const { kpiBoardFor } = await import("@/lib/channel-kpis/agent-view");
    return await kpiBoardFor(admin, admin, { id: "", role: "exec", isExec: true, isLead: true }, clientId, line, { cycle: false });
  } catch {
    return null;
  }
}

// ─── The Asana project, its columns and fields ─────────────────────────────

/** The line's project, found the way the Email Board's mirror finds its own (src/lib/asana-project.ts); null when nothing names one */
export async function projectFor(admin: Admin, cfg: LineConfig): Promise<string | null> {
  const { resolveAsanaProject, pickByName } = await import("@/lib/asana-project");
  if (cfg.line === "email") return (await resolveAsanaProject(admin, (await import("@/lib/asana-email")).EMAIL_PROJECT_SOURCE))?.gid ?? null;
  const p = cfg.asana.project;
  return (await resolveAsanaProject(admin, { env: p.env, setting: p.setting, pick: p.nameLike ? pickByName(p.nameLike) : undefined, syncSource: p.syncSource, fixed: p.gid }))?.gid ?? null;
}

/** Said when no project is found: what to set, so it's fixed once */
const noProject = (cfg: LineConfig) =>
  `No Asana project is set for ${cfg.label.toLowerCase()} requests, so nothing was sent. An admin sets it in app_settings (${cfg.asana.project.setting ?? "the line's setting"} = {"gid": "<project id>"})${cfg.asana.project.env ? ` or ${cfg.asana.project.env}` : ""}.`;

type Setting = { custom_field: { gid: string; name: string; resource_subtype: string; enum_options?: { gid: string; name: string; enabled?: boolean }[] } };
async function projectFields(project: string): Promise<AsanaFieldSetting[]> {
  const { asana } = await import("@/lib/asana");
  const r = await asana<Setting[]>(`/projects/${project}/custom_field_settings`, { opt_fields: "custom_field.gid,custom_field.name,custom_field.resource_subtype,custom_field.enum_options.gid,custom_field.enum_options.name,custom_field.enum_options.enabled" }).catch(() => ({ data: [] as Setting[] }));
  return r.data.map((s) => ({ gid: s.custom_field.gid, name: s.custom_field.name, type: s.custom_field.resource_subtype, options: s.custom_field.enum_options ?? [] }));
}

/** The client's strategist on the line, and their Asana user (by email, else the mirror's mapping of their tasks) */
async function strategistFollower(admin: Admin, cfg: LineConfig, clientId: string) {
  const { data: seats } = await admin.from("client_assignments").select("role, profile_id, is_primary, created_at, profiles(full_name, email)").eq("client_id", clientId).eq("role", cfg.followerSeat);
  const { primaryOf } = await import("@/lib/buyer-seats");
  const s = primaryOf((seats ?? []) as unknown as Parameters<typeof primaryOf>[0], cfg.followerSeat) as unknown as { profile_id: string; profiles: { full_name: string; email: string | null } | null } | null;
  const seat = s?.profiles ? { name: s.profiles.full_name, email: s.profiles.email } : null;
  let user: string | null = null;
  if (seat) {
    const { asana } = await import("@/lib/asana");
    const emails = [seat.email];
    if (cfg.asana.mirror) {
      const { data: m } = await admin.from(cfg.asana.mirror).select("assignee_email").eq("profile_id", s!.profile_id).not("assignee_email", "is", null).limit(1).maybeSingle();
      if (m?.assignee_email) emails.push(m.assignee_email as string);
    }
    for (const e of [...new Set(emails.filter(Boolean) as string[])]) {
      const u = await asana<{ gid: string }>(`/users/${encodeURIComponent(e)}`, { opt_fields: "gid" }).catch(() => null);
      if (u?.data?.gid) {
        user = u.data.gid;
        break;
      }
    }
  }
  return { ...followerOf(cfg.followerSeat.replace(/_/g, " "), seat, user), email: seat?.email ?? null };
}

/** The line's collaborators (people in the staff roles it names, e.g. the head of creative) as Asana users by email */
async function collaboratorsOf(admin: Admin, cfg: LineConfig): Promise<{ emails: string[]; users: string[] }> {
  if (!cfg.collaborators?.length) return { emails: [], users: [] };
  const { data } = await admin.from("profiles").select("email").in("role", cfg.collaborators).not("email", "is", null).limit(4);
  const emails = [...new Set((data ?? []).map((p) => String(p.email)).filter(Boolean))];
  const { asana } = await import("@/lib/asana");
  const users: string[] = [];
  for (const e of emails) {
    const u = await asana<{ gid: string }>(`/users/${encodeURIComponent(e)}`, { opt_fields: "gid" }).catch(() => null);
    if (u?.data?.gid) users.push(u.data.gid);
  }
  return { emails, users };
}

/** The social line's quick links: the account sheet's calendar, the creative folder, the client's HQ and website */
async function socialLinks(admin: Admin, clientId: string, facts: { hqUrl: string | null; website: string | null }) {
  const { data } = await admin.from("clients").select("channel_sheet, creative_db").eq("id", clientId).maybeSingle();
  const sheet = (((data?.channel_sheet ?? {}) as Record<string, unknown>).social_details ?? {}) as Record<string, string | null>;
  return [
    { label: "Social Media Calendar", url: sheet.calendar ?? "" },
    { label: "Ad Creative Folder", url: sheet.creativeFolder ?? (data?.creative_db as { url?: string } | null)?.url ?? "" },
    { label: "Client Headquarters Link", url: facts.hqUrl ?? "" },
    { label: "Website", url: facts.website ?? "" },
  ];
}

export type RequestsResult = { ok: true; doc: string; tasks: Request[]; fieldsMissing: string[]; followerMissing: string | null } | { ok: false; error: string; fixHref?: string; askForLink?: boolean };

/**
 * The requests for an approved run: the Google Doc (made now if it isn't), then one task per item or one for the
 * document, in the line's project and column, fields by name, no assignee or due date, the strategist following.
 */
/** The run's requests made in Asana as the person (their own Asana; without it they're asked to connect first) */
export async function createRequests(admin: Admin, db: SupabaseClient, me: Me, run: Run, opts: Parameters<typeof createRequestsAs>[4] = {}): Promise<RequestsResult> {
  const { asanaAsPerson } = await import("@/lib/asana-user");
  return asanaAsPerson(admin, me.id, () => createRequestsAs(admin, db, me, run, opts));
}

async function createRequestsAs(admin: Admin, db: SupabaseClient, me: Me, run: Run, opts: { urgency?: "urgent" | "high" | "normal" | "low"; /** A Headquarters folder link the person pasted */ hqLink?: string | null; /** Each step as it starts, for the progress bar ("Building the doc", "Creating task 2 of 3") */ onStep?: (step: string, i: number, n: number) => void } = {}): Promise<RequestsResult> {
  const { cfg, state } = run;
  if (!state.docId) return { ok: false, error: "There's no copy yet." };
  if (state.requests.length) return { ok: true, doc: "", tasks: state.requests, fieldsMissing: [], followerMissing: state.requests[0]?.followerMissing ?? null };
  opts.onStep?.("Building the Google Doc", 0, 3);
  const approvedDoc = await approveCopyDoc(admin, db, me, state.docId, { folder: cfg.doc.folder, line: cfg.line, hqLink: opts.hqLink ?? null });
  if (!approvedDoc.ok) return approvedDoc;
  const d = await loadCopyDoc(db, state.docId);
  if (!d || !d.clientId) return { ok: false, error: "That copy isn't one you can request." };
  const { asanaConfigured, asana, asanaWrite } = await import("@/lib/asana");
  if (!asanaConfigured()) return { ok: false, error: "Asana isn't connected (ASANA_TOKEN)." };
  opts.onStep?.("Finding the Asana project and column", 1, 3);
  const project = await projectFor(admin, cfg);
  if (!project) return { ok: false, error: noProject(cfg) };
  const [facts, sections, fields, follow] = await Promise.all([
    clientFacts(admin, d.clientId, cfg.line),
    asana<{ gid: string; name: string }[]>(`/projects/${project}/sections`, { opt_fields: "name" }).then((r) => r.data).catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    projectFields(project),
    strategistFollower(admin, cfg, d.clientId),
  ]);
  // The Headquarters the Doc went in, when the client had no HQ link stored
  if (approvedDoc.hqUrl && !facts.hqLinks.length) facts.hqUrl = approvedDoc.hqUrl;
  const urgency = opts.urgency ?? "normal";
  const c = d.content;
  const collab = await collaboratorsOf(admin, cfg);
  if (cfg.asana.via === "creative_form") {
    // The request form's own path: the same task, allotment counting and from_kaizen_ads as a request sent there
    const { why } = await import("@/lib/live-guard").then(async (m) => ({ why: await m.notLive(db, d.clientId!) }));
    if (why) return { ok: false, error: why };
    const { creativeDraft } = await import("./lines/creative");
    const { sendAsanaRequest } = await import("@/lib/asana-request");
    const draft = creativeDraft({ clientId: d.clientId, kind: state.kind ?? "image", count: state.count ?? 1, content: c, angle: state.topics[0]?.angle ?? "", urgency, landing: facts.website });
    try {
      const sent = await sendAsanaRequest(admin, draft, { id: me.id, email: me.email }, { origin: { kind: "brief", label: c.title }, followers: [...(follow.email ? [follow.email] : []), ...collab.emails] });
      const tasks: Request[] = sent.tasks.map((t) => ({ name: t.name, url: t.url ?? "", gid: t.gid, follower: follow.follower, followerMissing: follow.missing }));
      await admin.from("copy_docs").update({ status: "requested", asana_gid: tasks[0]?.gid ?? null, asana_url: tasks[0]?.url ?? null, updated_at: new Date().toISOString() }).eq("id", d.id);
      return { ok: true, doc: approvedDoc.docUrl, tasks, fieldsMissing: [], followerMissing: follow.missing };
    } catch (e) {
      return { ok: false, error: `Asana refused the request: ${e instanceof Error ? e.message : "unknown"}` };
    }
  }
  if (sections instanceof Error) return { ok: false, error: `Asana wouldn't open the ${cfg.label.toLowerCase()} requests project (${project}): ${sections.message.slice(0, 160)}. Check the project id in ${cfg.asana.project.setting ?? "the setting"}.` };
  const column = requestSection(sections, cfg.asana.section);
  if (!column.ok) return { ok: false, error: column.error };
  const section = column.section;
  const links = cfg.line === "social" ? await socialLinks(admin, d.clientId, facts) : [];
  const isDay = (x: unknown): x is string => typeof x === "string" && /^d{4}-d{2}-d{2}$/.test(x);
  const items = c.emails.map((e, i) => ({
    extra: cfg.asana.description ? { concept: state.topics[i] ? `${state.topics[i].angle || state.topics[i].title}` : c.brief.goal || e.name, postDate: [state.topics[i]?.send, c.emails.length === 1 ? c.brief.sendDate : null].find(isDay) ?? null, slides: slidesOfPost(e), links } : undefined,
    shortName: c.emails.length > 1 ? (state.topics[i]?.title || e.name) : c.shortName, docUrl: approvedDoc.docUrl, purpose: purposeText({ ...c, title: state.topics[i]?.title || c.title, brief: { ...c.brief, goal: state.topics[i] ? `${state.topics[i].title}: ${state.topics[i].angle}` : c.brief.goal } }) }));
  const planned = tasksFor(cfg, state, items, { client: facts, urgency }, c.shortName, approvedDoc.docUrl, purposeText(c));
  const { requestDescription } = await import("@/lib/copy-docs/core");
  const missingAll = new Set<string>();
  const made: Request[] = [];
  for (const [i, p] of planned.entries()) {
    opts.onStep?.(planned.length > 1 ? `Creating task ${i + 1} of ${planned.length} in Asana` : "Creating the Asana task", 2 + i / planned.length, 3);
    const { custom_fields, missing } = mapAsanaFields(fields, p.fields);
    missing.forEach((m) => missingAll.add(m.name));
    const notes = [cfg.asana.description ? cfg.asana.description(p.input) : requestDescription(c, { copyUrl: approvedDoc.docUrl, hqUrl: facts.hqUrl, website: facts.website, figma: facts.figma, platform: facts.platform, requestedBy: me.fullName }), missing.length ? missing.map((m) => `${m.name}: ${m.value}`).join("\n") : "", follow.missing ?? ""].filter(Boolean).join("\n\n");
    // Always in the project (projects), then moved into the column: never a task without its project
    const base: Record<string, unknown> = { name: p.name, notes: notes.slice(0, 60000), projects: [project], ...(Object.keys(custom_fields).length ? { custom_fields } : {}) };
    const followers = [...new Set([follow.follower, ...collab.users, me.email].filter(Boolean) as string[])];
    let task: { gid: string; permalink_url?: string };
    try {
      task = await asanaWrite("/tasks?opt_fields=permalink_url", { ...base, ...(followers.length ? { followers } : {}) });
    } catch {
      try {
        task = await asanaWrite("/tasks?opt_fields=permalink_url", base);
      } catch (e) {
        return { ok: false, error: `Asana refused the task${made.length ? ` after ${made.length} were made` : ""}: ${e instanceof Error ? e.message : "unknown"}` };
      }
    }
    await asanaWrite(`/sections/${section.gid}/addTask`, { task: task.gid }).catch((e) => console.error("[deliverables] column", e instanceof Error ? e.message : e));
    const url = task.permalink_url ?? `https://app.asana.com/0/${project}/${task.gid}`;
    made.push({ name: p.name, url, gid: task.gid, follower: follow.follower, followerMissing: follow.missing });
    if (cfg.asana.mirror === "email_asana_tasks") {
      const { emailStageForColumn } = await import("@/lib/email-board-core");
      const now = new Date().toISOString();
      await admin.from("email_asana_tasks").upsert({
        gid: task.gid,
        name: p.name,
        notes: notes.slice(0, 20000),
        section: section.name,
        stage: emailStageForColumn(section.name) ?? "copy_review",
        client_id: d.clientId,
        kind: p.input.kind.key === "flow" ? "flow" : "batch",
        priority: urgency === "urgent" || urgency === "high" ? urgency : null,
        created_by_name: me.fullName,
        url,
        fields: Object.fromEntries(p.fields.filter((f) => f.value).map((f) => [f.name, f.value])),
        open: true,
        asana_created_at: now,
        asana_modified_at: now,
        synced_at: now,
        copy_doc_id: d.id,
      });
    }
  }
  await admin.from("copy_docs").update({ status: "requested", asana_gid: made[0]?.gid ?? null, asana_url: made[0]?.url ?? null, updated_at: new Date().toISOString() }).eq("id", d.id);
  return { ok: true, doc: approvedDoc.docUrl, tasks: made, fieldsMissing: [...missingAll], followerMissing: follow.missing };
}

/** A seat's person on the client (primary first) and their Asana user, by their email or the mirror's mapping */
async function seatAsanaUser(admin: Admin, clientId: string, role: string, mirror: string | null): Promise<{ name: string | null; user: string | null }> {
  const { data: seats } = await admin.from("client_assignments").select("role, profile_id, is_primary, created_at, profiles(full_name, email)").eq("client_id", clientId).eq("role", role);
  const { primaryOf } = await import("@/lib/buyer-seats");
  const s = primaryOf((seats ?? []) as unknown as Parameters<typeof primaryOf>[0], role) as unknown as { profile_id: string; profiles: { full_name: string; email: string | null } | null } | null;
  if (!s?.profiles) return { name: null, user: null };
  const emails = [s.profiles.email];
  if (mirror) {
    const { data: m } = await admin.from(mirror).select("assignee_email").eq("profile_id", s.profile_id).not("assignee_email", "is", null).limit(1).maybeSingle();
    if (m?.assignee_email) emails.push(m.assignee_email as string);
  }
  const { asana } = await import("@/lib/asana");
  for (const e of [...new Set(emails.filter(Boolean) as string[])]) {
    const u = await asana<{ gid: string }>(`/users/${encodeURIComponent(e)}`, { opt_fields: "gid" }).catch(() => null);
    if (u?.data?.gid) return { name: s.profiles.full_name, user: u.data.gid };
  }
  return { name: s.profiles.full_name, user: null };
}

export type SuppliedResult = { ok: true; task: Request; designer: string | null; designerMissing: string | null } | { ok: false; error: string };

/**
 * Client supplies the content: one Asana task in the Email Marketing project, straight to "Ready for Design" (the
 * Email Requests column when there's none), assigned to the client's email designer (auto-assign, as the board does),
 * the strategist following, every field filled with the client's sheet as the Copy link, and the emails read from the
 * sheet in the description. It counts against the allotment from its name ("(N)") like any batch, and the mirror tracks
 * its moves through the board.
 */
/** A supplied-content request made in Asana as the person (their own Asana; without it they're asked to connect) */
export async function createSuppliedRequest(...args: Parameters<typeof createSuppliedRequestAs>): ReturnType<typeof createSuppliedRequestAs> {
  const { asanaAsPerson } = await import("@/lib/asana-user");
  return asanaAsPerson(args[0], args[1].id, () => createSuppliedRequestAs(...args));
}

async function createSuppliedRequestAs(
  admin: Admin,
  me: Me,
  p: { clientId: string; sheetUrl: string; count: number; channel: "email" | "sms"; shortName: string; note: string | null; urgency: "urgent" | "high" | "normal" | "low"; emailsText: string | null; summary: string | null },
): Promise<SuppliedResult> {
  const cfg = lineOf("email");
  if (!cfg) return { ok: false, error: "The email line isn't set up." };
  const { asanaConfigured, asana, asanaWrite } = await import("@/lib/asana");
  if (!asanaConfigured()) return { ok: false, error: "Asana isn't connected (ASANA_TOKEN)." };
  const project = await projectFor(admin, cfg);
  if (!project) return { ok: false, error: noProject(cfg) };
  const [facts, sections, fields, follow, designer] = await Promise.all([
    clientFacts(admin, p.clientId, "email"),
    asana<{ gid: string; name: string }[]>(`/projects/${project}/sections`, { opt_fields: "name" }).then((r) => r.data).catch(() => null),
    projectFields(project),
    strategistFollower(admin, cfg, p.clientId),
    seatAsanaUser(admin, p.clientId, "email_designer", cfg.asana.mirror ?? null),
  ]);
  if (!sections) return { ok: false, error: "Asana wouldn't open the Email Marketing project." };
  const fallback = requestSection(sections, cfg.asana.section);
  const section = sections.find((x) => looseName(x.name) === looseName("Ready for Design")) ?? (fallback.ok ? fallback.section : null);
  if (!section) return { ok: false, error: 'No "Ready for Design" or "Email Requests" column in the Email Marketing project.' };
  const kind = cfg.kinds.find((k) => k.key === (p.channel === "sms" ? "sms" : "campaign")) ?? cfg.kinds[0];
  const count = Math.max(1, Math.min(kind.max, Math.round(p.count) || 1));
  const purpose = ["Client supplies the content: their team provides the images, copy and CTA links in the sheet linked in Copy. Build from the sheet as it is.", p.summary, p.note ? `Note: ${p.note}` : null].filter(Boolean).join("\n");
  const input = { client: { name: facts.name, kaizenId: facts.kaizenId, website: facts.website, hqUrl: facts.hqUrl, figma: facts.figma, platform: facts.platform }, kind, shortName: p.shortName, count, docUrl: p.sheetUrl, purpose, urgency: p.urgency };
  const name = cfg.asana.taskName(input);
  const wanted = cfg.asana.fields(input);
  const { custom_fields, missing } = mapAsanaFields(fields, wanted);
  const notes = [
    "Client supplies the content: images, copy and CTA links are in their sheet. No copy doc, no brief: build from the sheet.",
    `Sheet: ${p.sheetUrl}`,
    p.summary ?? "",
    p.emailsText ? `In the sheet:\n${p.emailsText}` : "",
    p.note ? `Note: ${p.note}` : "",
    [facts.hqUrl && `Client HQ: ${facts.hqUrl}`, facts.figma && `Figma: ${facts.figma}`, facts.website && `Website: ${facts.website}`, facts.platform && `Platform: ${facts.platform}`].filter(Boolean).join("\n"),
    `Requested by ${me.fullName} in Kaizen OS.`,
    missing.length ? missing.map((m) => `${m.name}: ${m.value}`).join("\n") : "",
    follow.missing ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const base: Record<string, unknown> = { name, notes: notes.slice(0, 60000), projects: [project], ...(Object.keys(custom_fields).length ? { custom_fields } : {}) };
  const followers = [...new Set([follow.follower, me.email].filter(Boolean) as string[])];
  let task: { gid: string; permalink_url?: string };
  try {
    task = await asanaWrite("/tasks?opt_fields=permalink_url", { ...base, ...(designer.user ? { assignee: designer.user } : {}), ...(followers.length ? { followers } : {}) });
  } catch {
    try {
      task = await asanaWrite("/tasks?opt_fields=permalink_url", base);
    } catch (e) {
      return { ok: false, error: `Asana refused the task: ${e instanceof Error ? e.message : "unknown"}` };
    }
  }
  await asanaWrite(`/sections/${section.gid}/addTask`, { task: task.gid }).catch((e) => console.error("[supplied request] column", e instanceof Error ? e.message : e));
  const url = task.permalink_url ?? `https://app.asana.com/0/${project}/${task.gid}`;
  const { emailStageForColumn } = await import("@/lib/email-board-core");
  const now = new Date().toISOString();
  await admin.from("email_asana_tasks").upsert({
    gid: task.gid,
    name,
    notes: notes.slice(0, 20000),
    section: section.name,
    stage: emailStageForColumn(section.name) ?? "ready_for_design",
    client_id: p.clientId,
    kind: "batch",
    priority: p.urgency === "urgent" || p.urgency === "high" ? p.urgency : null,
    assignee_name: designer.user ? designer.name : null,
    created_by_name: me.fullName,
    url,
    fields: Object.fromEntries(wanted.filter((f) => f.value).map((f) => [f.name, f.value])),
    open: true,
    asana_created_at: now,
    asana_modified_at: now,
    synced_at: now,
  });
  // The sheet is remembered for next week's request
  await admin.from("clients").update({ email_supplies_sheet: p.sheetUrl }).eq("id", p.clientId);
  return {
    ok: true,
    task: { name, url, gid: task.gid, follower: follow.follower, followerMissing: follow.missing },
    designer: designer.user ? designer.name : null,
    designerMissing: designer.user ? null : designer.name ? `${designer.name} wasn't found in Asana, so the task is unassigned.` : "No email designer is on this client, so the task is unassigned.",
  };
}

/** A fix to a request already made: fields by name, the description (replaced or added to), or its column. Never a delete. */
export async function updateRequest(admin: Admin, cfg: LineConfig, gid: string, change: { fields?: WantedField[]; description?: string; append?: boolean; section?: string; name?: string }) {
  const { asana, asanaUpdate, asanaWrite } = await import("@/lib/asana");
  const project = await projectFor(admin, cfg);
  if (!project) return { ok: false as const, error: noProject(cfg) };
  const data: Record<string, unknown> = {};
  let missing: string[] = [];
  if (change.fields?.length) {
    const m = mapAsanaFields(await projectFields(project), change.fields);
    if (Object.keys(m.custom_fields).length) data.custom_fields = m.custom_fields;
    missing = m.missing.map((x) => x.name);
  }
  if (change.name?.trim()) data.name = change.name.trim().slice(0, 250);
  if (change.description?.trim()) {
    if (change.append) {
      const cur = await asana<{ notes: string }>(`/tasks/${gid}`, { opt_fields: "notes" });
      data.notes = `${cur.data.notes ?? ""}\n\n${change.description.trim()}`.slice(0, 60000);
    } else data.notes = change.description.trim().slice(0, 60000);
  }
  if (Object.keys(data).length) await asanaUpdate(`/tasks/${gid}`, data);
  let moved: string | null = null;
  if (change.section?.trim()) {
    const sections = (await asana<{ gid: string; name: string }[]>(`/projects/${project}/sections`, { opt_fields: "name" })).data;
    const to = sections.find((s) => looseName(s.name) === looseName(change.section!)) ?? pickSection(sections, change.section);
    if (!to) return { ok: false as const, error: `No column named "${change.section}" in the project.` };
    await asanaWrite(`/sections/${to.gid}/addTask`, { task: gid });
    moved = to.name;
  }
  if (cfg.asana.mirror === "email_asana_tasks") {
    const patch: Record<string, unknown> = { synced_at: new Date().toISOString() };
    if (data.name) patch.name = data.name;
    if (typeof data.notes === "string") patch.notes = (data.notes as string).slice(0, 20000);
    if (moved) {
      const { emailStageForColumn } = await import("@/lib/email-board-core");
      patch.section = moved;
      patch.stage = emailStageForColumn(moved);
    }
    if (change.fields?.length) {
      const { data: row } = await admin.from("email_asana_tasks").select("fields").eq("gid", gid).maybeSingle();
      patch.fields = { ...((row?.fields ?? {}) as Record<string, string>), ...Object.fromEntries(change.fields.filter((f) => !missing.includes(f.name)).map((f) => [f.name, f.value])) };
    }
    await admin.from("email_asana_tasks").update(patch).eq("gid", gid);
  }
  return { ok: true as const, changed: Object.keys(data), moved, missing };
}
