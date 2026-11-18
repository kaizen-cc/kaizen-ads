import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Staff } from "@/lib/auth";
import type { CallEvent } from "@/lib/agent-call/core";
import type { LoopTool } from "@/lib/agent-call/tool-loop";
import { saidYes } from "@/lib/assistant/core";
import { COPY_BRIEF_SCHEMA, COPY_EMAIL_SCHEMA } from "@/lib/copy-docs/core";
import { nextStep, type Patch, type Topic } from "./engine";
import { LINES, lineOf } from "./lines";

// The deliverable flow's tools, for the assistant and every agent alike, on a call and in the chat: `deliverable` (start
// the run, read where it stands and what's next, pull fresh context, record the type, count, topics, approvals),
// create_copy_doc (the writer's preview document, a card on screen), approve_copy_doc (the Google Doc on its own),
// and per line the request (create_email_request: Asana now, Kaizen OS coming soon) and its fixes
// (update_email_request). Requests run only on the person's own yes.

export type DeliverableCtx = {
  me: Staff;
  db: SupabaseClient;
  admin: SupabaseClient;
  callId: string | null;
  /** What the person said on this turn */
  said: () => string;
  emit?: (e: CallEvent) => void;
  /** Who's using the tools: "assistant" or a specialist's role key */
  roleKey: string;
};

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const CONFIRMED = { type: "boolean", description: "True only after the person clearly said yes to this exact action on this turn" };
const NO_YES = "Not run: say in one sentence exactly what this will do and ask; run it again with confirmed: true only once they clearly say yes.";
/** The person approving the copy in their own words */
const APPROVES = /\b(?:approve[ds]?|looks? (?:good|great)|love (?:it|them|this)|perfect|ship it|good to go|that works|all good|yes)\b/i;

const asMe = (me: Staff) => ({ id: me.id, fullName: me.fullName, email: me.email ?? null });

async function clientNamed(db: SupabaseClient, name: unknown): Promise<{ id: string; name: string; slug: string }> {
  const asked = clip(name, 120);
  if (!asked) throw new Error("Which client?");
  const safe = asked.replace(/[%_,()]/g, " ").trim();
  const { data } = await db.from("clients").select("id, name, slug").is("archived_at", null).ilike("name", `%${safe}%`).limit(5);
  const hit = (data ?? []).find((c) => String(c.name).toLowerCase() === asked.toLowerCase()) ?? (data ?? [])[0];
  if (!hit) throw new Error(`No client called "${asked}" that you can see.`);
  return hit as { id: string; name: string; slug: string };
}

const topicsOf = (v: unknown): Topic[] =>
  (Array.isArray(v) ? (v as Record<string, unknown>[]) : []).slice(0, 12).map((t) => ({
    title: clip(t.title, 120),
    angle: clip(t.angle, 400),
    offer: clip(t.offer, 300),
    include: (Array.isArray(t.include) ? t.include : []).map((x) => clip(x, 120)).filter(Boolean).slice(0, 10),
    exclude: (Array.isArray(t.exclude) ? t.exclude : []).map((x) => clip(x, 120)).filter(Boolean).slice(0, 10),
    send: clip(t.send, 120),
  })).filter((t) => t.title);

export function deliverableTools(ctx: DeliverableCtx): LoopTool[] {
  const card = (c: { title: string; detail: string; href: string; external: boolean; cta: string; copy?: import("@/lib/agent-call/core").CallCopyDoc }) => ctx.emit?.({ t: "card", card: { id: crypto.randomUUID().slice(0, 8), ...c } });
  const view = async (run: import("./server").Run) => {
    const next = nextStep(run.cfg, run.state);
    const s = run.state;
    return { line: run.cfg.line, client: s.client?.name ?? null, kind: s.kind, count: s.count, topics: s.topics, topics_agreed: s.topicsAgreed, copy_doc_id: s.docId, version: s.docVersion, approved_by_person: s.personApproved === s.docVersion && s.docVersion > 0, approved_by_lead: s.leadApproved === s.docVersion && s.docVersion > 0, requests: s.requests, next: { step: next.step, who: next.who === "lead" ? run.cfg.lead : next.who === "writer" ? run.cfg.writer : "assistant", do: next.say } };
  };

  const tools: LoopTool[] = [
    {
      name: "deliverable",
      description: `The conversational flow for making a deliverable with the person (${LINES.map((l) => `${l.line}: the ${l.lead.replace(/_/g, " ")} leads, the ${l.writer} writes`).join("; ")}). One run per call, shared by everyone on it: always read next (who acts and what to do) and follow it, short and natural. action: start (client, line) when they ask to create campaigns, flows or other deliverables; status; context (fresh account context before brainstorming: KPIs, recent sends, segments, latest Slack, Gmail and call notes, promises from calls, open requests, the client's rules); update (kind, count, topics with agreed: true once they agree); approve (by: person when the person said they approve the copy this turn, by: lead when you are the lead and approve it); asked (the lead asked to create the requests); wrap (done). Ask the type and how many only when it's missing.`,
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "status", "context", "update", "approve", "asked", "wrap"] },
          client: { type: "string", description: "The client's name (start)" },
          line: { type: "string", enum: LINES.map((l) => l.line) },
          kind: { type: "string", description: "campaign, flow or sms (email)" },
          count: { type: "integer" },
          topics: { type: "array", items: { type: "object", properties: { title: { type: "string" }, angle: { type: "string" }, offer: { type: "string" }, include: { type: "array", items: { type: "string" } }, exclude: { type: "array", items: { type: "string" } }, send: { type: "string" } }, required: ["title"] } },
          agreed: { type: "boolean", description: "The person agreed the topics" },
          by: { type: "string", enum: ["person", "lead"] },
        },
        required: ["action"],
        additionalProperties: false,
      },
      status: (input) => (input.action === "context" ? "Pulling fresh context…" : "Checking where we are…"),
      run: async (input) => {
        if (!ctx.callId) return { note: "This works on a call or in the assistant's chat." };
        const { currentRun, startRun, patchRun, freshContext } = await import("./server");
        const action = String(input.action);
        if (action === "start") {
          const cfg = lineOf(String(input.line ?? "email")) ?? LINES[0];
          let c;
          try {
            c = await clientNamed(ctx.db, input.client);
          } catch (e) {
            return { started: false, note: `${e instanceof Error ? e.message : "No such client."} Ask which client.` };
          }
          let run = await startRun(ctx.admin, asMe(ctx.me), ctx.callId, cfg, { id: c.id, name: c.name }, ctx.said());
          const patch: Patch = {};
          if (input.kind) patch.kind = String(input.kind);
          if (input.count) patch.count = Number(input.count);
          if (Object.keys(patch).length) {
            const r = await patchRun(ctx.admin, run, patch);
            if (!r.ok) return { started: true, refused: r.why, ...(await view(run)) };
            run = r.run;
          }
          return { started: true, ...(await view(run)) };
        }
        const run = await currentRun(ctx.admin, ctx.callId, typeof input.line === "string" ? input.line : null);
        if (!run) return { note: "Nothing started on this call: start it with the client first." };
        if (action === "status") return view(run);
        if (action === "context") {
          if (!run.state.client) return { note: "Which client?" };
          const fresh = await freshContext(ctx.admin, run.cfg, run.state.client.id);
          const r = await patchRun(ctx.admin, run, { contextPulled: true });
          return { context: fresh, ...(await view(r.ok ? r.run : run)) };
        }
        const patch: Patch = {};
        if (action === "update") {
          if (input.kind) patch.kind = String(input.kind);
          if (input.count != null) patch.count = Number(input.count);
          if (input.topics) patch.topics = topicsOf(input.topics);
          if (typeof input.agreed === "boolean") {
            // The topics are agreed in the person's own words, not on an agent's say-so
            if (input.agreed && !saidYes(ctx.said()) && !APPROVES.test(ctx.said()) && !/\b(?:go with|let'?s do|sounds good|agreed?|those|that one|works)\b/i.test(ctx.said())) return { updated: false, note: "Ask them to agree the topics first; record agreed only on their own yes.", ...(await view(run)) };
            patch.agreed = input.agreed;
          }
        } else if (action === "approve") {
          if (input.by === "lead") {
            if (ctx.roleKey !== run.cfg.lead) return { updated: false, note: `Only the ${run.cfg.lead.replace(/_/g, " ")} approves as the lead.` };
            patch.approve = "lead";
          } else {
            if (!APPROVES.test(ctx.said())) return { updated: false, note: "They haven't approved it in their own words this turn. Ask what they think." };
            patch.approve = "person";
          }
        } else if (action === "asked") patch.asked = true;
        else if (action === "wrap") patch.wrapped = true;
        const r = await patchRun(ctx.admin, run, patch);
        if (!r.ok) return { updated: false, refused: r.why, ...(await view(run)) };
        return { updated: true, ...(await view(r.run)) };
      },
    },
    {
      name: "create_copy_doc",
      description:
        "Writes campaign, flow or SMS copy for the email team into ONE preview document (a section per email: subject, preview text, body sections, button, design notes), shown as a document card to read, comment on and approve. This is copy for the email team to design and send to the client's list, never a message to anyone: no greeting to a contact, nobody's name. In the deliverable flow, only once the topics are agreed. To revise, pass copy_doc_id with the whole new content (the earlier version is kept). Write from the client's knowledge and brand rules. After it's on screen, ask what they think in a line.",
      input_schema: {
        type: "object",
        properties: {
          client: { type: "string", description: "The client's name" },
          kind: { type: "string", enum: ["campaign", "flow", "sms"] },
          title: { type: "string" },
          short_name: { type: "string", description: "Short name for the request title (Scratch to Win)" },
          emails: { type: "array", items: COPY_EMAIL_SCHEMA },
          brief: COPY_BRIEF_SCHEMA,
          copy_doc_id: { type: "string", description: "The document to revise" },
          why: { type: "string", description: "A revision: what changed and why, a few words" },
        },
        required: ["kind", "title", "emails"],
        additionalProperties: false,
      },
      status: (input) => (input.copy_doc_id ? "Revising the copy…" : "Writing the copy…"),
      run: async (input) => {
        const { saveCopyDoc, copyCard, loadCopyDoc } = await import("@/lib/copy-docs/server");
        const { currentRun, patchRun } = await import("./server");
        const run = ctx.callId ? await currentRun(ctx.admin, ctx.callId, "email") : null;
        if (run && !run.state.topicsAgreed) return { made: false, note: "Agree the topics with them first (the lead records them), then draft." };
        const id = typeof input.copy_doc_id === "string" && /^[0-9a-f-]{36}$/i.test(input.copy_doc_id) ? input.copy_doc_id : (run?.state.docId ?? null);
        let client: { id: string; name: string } | null = run?.state.client ?? null;
        if (!client && input.client) {
          try {
            client = await clientNamed(ctx.db, input.client);
          } catch (e) {
            return { made: false, note: e instanceof Error ? e.message : "Which client?" };
          }
        }
        if (!client && !id) return { made: false, note: "Which client is it for?" };
        let doc;
        try {
          doc = await saveCopyDoc(ctx.admin, ctx.db, asMe(ctx.me), { client, loose: input, id, why: clip(input.why, 300) || null, callId: ctx.callId });
        } catch (e) {
          return { made: false, error: e instanceof Error ? e.message : "It didn't save." };
        }
        if (run) await patchRun(ctx.admin, run, { doc: { id: doc.id, version: doc.version } });
        const fresh = (await loadCopyDoc(ctx.db, doc.id)) ?? doc;
        card({ title: fresh.content.title, detail: `${fresh.client ?? ""} · ${fresh.content.emails.length} ${fresh.content.kind === "sms" ? "text" : "email"}${fresh.content.emails.length === 1 ? "" : "s"}${fresh.version > 1 ? ` · v${fresh.version}` : ""}`, href: `/copy/${fresh.id}`, external: false, cta: "Open", copy: copyCard(fresh) });
        return { made: true, copy_doc_id: fresh.id, version: fresh.version, open: `/copy/${fresh.id}`, note: "The document card is on screen (Open shows it full screen to comment on lines). Ask what they think in a line; don't read it all out." };
      },
    },
    {
      name: "approve_copy_doc",
      description: "Approves a copy document on its own (outside the deliverable flow): a Google Doc of it in the client's headquarters Drive folder under Email Marketing (made when missing), as the person. Returns the Doc link. Ask first; confirmed: true only on their yes.",
      input_schema: { type: "object", properties: { copy_doc_id: { type: "string" }, confirmed: CONFIRMED }, required: ["copy_doc_id"], additionalProperties: false },
      status: () => "Putting it in their Drive…",
      run: async (input) => {
        if (input.confirmed !== true || !saidYes(ctx.said())) return { done: false, note: NO_YES };
        const { approveCopyDoc } = await import("@/lib/copy-docs/server");
        const r = await approveCopyDoc(ctx.admin, ctx.db, asMe(ctx.me), clip(input.copy_doc_id, 40));
        if (!r.ok) return { done: false, error: r.error };
        card({ title: "Approved copy (Google Doc)", detail: `In ${r.folder}`, href: r.docUrl, external: true, cta: "Open the Doc" });
        return { approved: true, doc: r.docUrl, made_as: r.asPerson ? "them" : "the shared Drive user", note: "The Doc's card is on screen." };
      },
    },
  ];

  for (const cfg of LINES) {
    tools.push(
      {
        name: cfg.tools.request,
        description: `Creates the ${cfg.label.toLowerCase()} request for approved copy. where: asana (now) or kaizen (Kaizen OS requests are coming soon: say so). Asana: makes the Google Doc in the client's HQ Drive (${cfg.doc.folder}) if it isn't there, then the task${cfg.kinds.some((k) => k.split === "per_item") ? "s (one per campaign; a flow is one task with its email count)" : ""} in the ${cfg.asana.section} column with the fields filled, no assignee or due date (the strategists set those), the client's ${cfg.followerSeat.replace(/_/g, " ")} following. Link cards show. Only after both approved and you asked; confirmed: true on their yes.`,
        input_schema: { type: "object", properties: { where: { type: "string", enum: ["asana", "kaizen"] }, copy_doc_id: { type: "string" }, priority: { type: "string", enum: ["urgent", "high", "normal", "low"] }, confirmed: CONFIRMED }, required: ["where"], additionalProperties: false },
        status: () => "Creating the request…",
        run: async (input) => {
          if (input.where === "kaizen" && !cfg.kaizenRequests) return { created: false, note: "Kaizen OS requests are coming soon: for now it goes to Asana. Offer Asana." };
          if (input.confirmed !== true || !saidYes(ctx.said())) return { created: false, note: NO_YES };
          const { currentRun, patchRun, createRequests, startRun } = await import("./server");
          const { canRequest } = await import("./engine");
          let run = ctx.callId ? await currentRun(ctx.admin, ctx.callId, cfg.line) : null;
          if (!run) {
            // Copy approved outside the flow: a run for it, approved as it stands
            const { loadCopyDoc } = await import("@/lib/copy-docs/server");
            const d = typeof input.copy_doc_id === "string" ? await loadCopyDoc(ctx.db, input.copy_doc_id) : null;
            if (!d || !d.clientId || !ctx.callId) return { created: false, note: "Which copy? Make it first (create_copy_doc)." };
            run = await startRun(ctx.admin, asMe(ctx.me), ctx.callId, cfg, { id: d.clientId, name: d.client ?? "" }, "");
            const steps: Patch[] = [{ kind: d.content.kind, count: d.content.emails.length }, { topics: d.content.emails.map((e) => ({ title: e.name, angle: "", offer: "", include: [], exclude: [], send: "" })), agreed: true }, { doc: { id: d.id, version: d.version } }, { approve: "person" }, { approve: "lead" }, { asked: true }];
            for (const p of steps) {
              const r = await patchRun(ctx.admin, run, p);
              if (r.ok) run = r.run;
            }
          }
          if (!canRequest(run.state)) return { created: false, note: "Not yet: the person and the lead both approve the latest version, then the lead asks. Read next from deliverable status." };
          const r = await createRequests(ctx.admin, ctx.db, asMe(ctx.me), run, { urgency: typeof input.priority === "string" ? (input.priority as "urgent") : undefined });
          if (!r.ok) return { created: false, error: r.error };
          await patchRun(ctx.admin, run, { requests: r.tasks });
          if (r.doc) card({ title: "The copy (Google Doc)", detail: `${run.state.client?.name ?? ""} · ${cfg.doc.folder}`, href: r.doc, external: true, cta: "Open the Doc" });
          for (const t of r.tasks) card({ title: t.name, detail: `Asana · ${cfg.asana.section}${t.followerMissing ? ` · ${t.followerMissing}` : ""}`, href: t.url, external: true, cta: "Open in Asana" });
          return { created: true, doc: r.doc, tasks: r.tasks.map((t) => ({ name: t.name, url: t.url, gid: t.gid })), ...(r.fieldsMissing.length ? { fields_not_in_project: r.fieldsMissing, note_fields: "Those went in the description instead." } : {}), ...(r.followerMissing ? { follower: r.followerMissing } : {}), note: "The link cards are on screen. Say it's in Asana in a line; then the assistant asks if there's anything else." };
        },
      },
      {
        name: cfg.tools.update,
        description: `Fixes a ${cfg.label.toLowerCase()} request already in Asana when the person says something's off ("the purpose is off", "wrong platform", "move it to Needs Revision"): fields by their names, the description (replace, or append: true), the task name, or its column. Their correction is the ask. Never deletes anything.`,
        input_schema: {
          type: "object",
          properties: {
            task: { type: "string", description: "The task's gid or Asana link (from the request's result)" },
            fields: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: { type: "string" } }, required: ["name", "value"] } },
            description: { type: "string" },
            append: { type: "boolean" },
            name: { type: "string" },
            section: { type: "string", description: "The column to move it to" },
          },
          required: ["task"],
          additionalProperties: false,
        },
        status: () => "Fixing the task…",
        run: async (input) => {
          const raw = clip(input.task, 300);
          const gid = /^\d{6,}$/.test(raw) ? raw : (raw.match(/\/(\d{6,})(?:\/f)?\/?$/)?.[1] ?? raw.match(/(\d{10,})/g)?.at(-1) ?? null);
          if (!gid) return { updated: false, note: "Which task? Its link from the request." };
          const { updateRequest } = await import("./server");
          const fields = (Array.isArray(input.fields) ? (input.fields as { name: string; value: string }[]) : []).map((f) => ({ name: clip(f.name, 80), value: String(f.value ?? "").slice(0, 1000) })).filter((f) => f.name);
          try {
            const r = await updateRequest(ctx.admin, cfg, gid, { fields, description: typeof input.description === "string" ? input.description : undefined, append: input.append === true, name: typeof input.name === "string" ? input.name : undefined, section: typeof input.section === "string" ? input.section : undefined });
            if (!r.ok) return { updated: false, error: r.error };
            return { updated: true, changed: r.changed, moved: r.moved, ...(r.missing.length ? { not_in_project: r.missing } : {}), note: "Say what you fixed in a few words." };
          } catch (e) {
            return { updated: false, error: e instanceof Error ? e.message : "Asana refused the change." };
          }
        },
      },
    );
  }
  return tools;
}
