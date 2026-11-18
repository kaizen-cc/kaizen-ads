import "server-only";
import type { ChatTool, ToolCtx } from "./tools";
import { STEPS, asStep, progress, type ItemState } from "@/lib/csuite/core";
import { DRAFT_KINDS, type DraftKind } from "@/lib/email-drafts/core";
import { LIVE } from "@/lib/live";

// The account review and client email drafts as tools, so the assistant can run the weekly review on a call ("let's do
// the account review") step by step, capture to-dos for people, and draft client emails in bulk ("draft an email for
// each of these 12 upsell clients"). Each answer carries the screen's address for open_screen. Drafts are never sent.

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const STEP_KEYS = STEPS.map((s) => s.key);

export function csuiteTools(ctx: ToolCtx): ChatTool[] {
  const exec = ctx.me.isExec;
  const tools: ChatTool[] = [];
  if (exec) {
    tools.push(
      {
        name: "account_review",
        description: `The executives' weekly full-account review (EOS style), step by step: ${STEPS.map((s, i) => `${i + 1}) ${s.title}`).join(", ")}. Use when they say "let's do the account review" (start: true opens this week's meeting, or carries on the open one) and as you walk through it: each step returns its items (with keys for review_item) and the address to open_screen (href). Go one step at a time, a few items per turn, most important first; ask what they decided on each.`,
        input_schema: { type: "object", properties: { step: { type: "string", enum: STEP_KEYS }, start: { type: "boolean" } }, additionalProperties: false },
        status: (input) => `Reading the ${STEPS.find((s) => s.key === input.step)?.title.toLowerCase() ?? "account review"}…`,
        run: async (input) => {
          const [{ loadReview, openMeeting, meetingTodos }, { startMeeting, setStep }] = await Promise.all([import("@/lib/csuite/load"), import("@/lib/csuite/server")]);
          const review = await loadReview(ctx.db, ctx.admin);
          let meeting = await openMeeting(ctx.db);
          if (!meeting && input.start === true) {
            await startMeeting(ctx.db, ctx.me, review);
            meeting = await openMeeting(ctx.db);
          }
          const step = asStep(typeof input.step === "string" ? input.step : meeting ? STEPS[meeting.step]?.key : "scorecard");
          if (meeting) await setStep(ctx.db, meeting.id, STEPS.findIndex((s) => s.key === step));
          const marks = meeting?.items ?? {};
          const p = progress(review.items, marks);
          const state = (k: string) => marks[k]?.state ?? "open";
          const s = review.scorecard;
          const pct = (x: number | null) => (x == null ? null : Math.round(x * 100));
          const body =
            step === "scorecard"
              ? { lines_on_target_pct: pct(s.lineRatio), lines: `${s.linesOn} of ${s.linesJudged}`, clients_on_every_line_pct: pct(s.clientRatio), in_the_red: s.inRed, critical: review.critical, by_line: s.lines.map((l) => ({ key: `scorecard:${l.line}`, line: l.line, on: l.on, close: l.close, off: l.off, improving: l.improving, slipping: l.slipping, spend_14d: Math.round(l.spend), revenue_14d: Math.round(l.revenue), pacing_pct: pct(l.pace), state: state(`scorecard:${l.line}`) })) }
              : step === "critical"
                ? { accounts: review.criticalRows.map((c, i) => ({ key: c.key, rank: i + 1, client: c.name, at_risk: c.atRisk || undefined, lines: c.lines.map((l) => `${l.line} ${l.shown}`), reasons: c.reasons, state: state(c.key) })) }
                : step === "issues"
                  ? { account_watch_running: review.watchOn, issues: review.issues.slice(0, 20).map((x) => ({ key: x.key, client: x.client, from: x.source, severity: x.severity, title: x.title, detail: x.detail, state: state(x.key) })) }
                  : step === "upsell"
                    ? { upsells: review.upsells.slice(0, 15).map((u) => ({ key: u.key, client: u.client, offer: u.offer, service: u.service, why: u.why.slice(0, 3), state: state(u.key) })), note: "draft_client_emails with kind upsell drafts these for the person (never sent)." }
                    : step === "financial"
                      ? { billing_from_stripe: review.billingKnown, clients: review.financial.slice(0, 25).map((f) => ({ key: f.key, client: f.name, monthly_billed: f.monthly, services: f.services, package: f.packageLabel, billed_not_listed: f.unlisted.length ? f.unlisted : undefined, listed_not_billed: f.unbilled.length ? f.unbilled : undefined })) }
                      : { todos: (await meetingTodos(ctx.db, meeting?.id ?? null)).map((t) => ({ title: t.title, who: t.assignee?.name, due: t.due_on, status: t.status, client: t.client?.name })) };
          return { meeting: meeting ? { id: meeting.id, title: meeting.title } : null, step: STEPS.find((x) => x.key === step)!.title, progress: `${p.done} of ${p.total} items done`, ...body, href: `/kpis?p=review&step=${step}`, next_step: STEPS[STEPS.findIndex((x) => x.key === step) + 1]?.key ?? null };
        },
      },
      {
        name: "review_item",
        description: "Marks an item in the open account review as discuss (come back to it) or done, with an optional note of what was decided, or clears it (state: clear). Keys come from account_review.",
        input_schema: { type: "object", properties: { key: { type: "string" }, state: { type: "string", enum: ["discuss", "done", "clear"] }, note: { type: "string" } }, required: ["key", "state"], additionalProperties: false },
        status: () => "Noting it…",
        run: async (input) => {
          const [{ openMeeting }, { markItem }] = await Promise.all([import("@/lib/csuite/load"), import("@/lib/csuite/server")]);
          const m = await openMeeting(ctx.db);
          if (!m) return { done: false, note: "No review is open: run account_review with start: true first." };
          await markItem(ctx.db, m.id, clip(input.key, 200), input.state === "clear" ? null : (input.state as ItemState), clip(input.note, 600) || null);
          return { done: true };
        },
      },
      {
        name: "assign_review_todo",
        description: "Captures a decision or to-do in the account review for a person (by name or role), with a due date (YYYY-MM-DD; default a week out) and optionally the client and the agenda item key. It lands on their Overview and in their notifications. Say who and when in a few words.",
        input_schema: { type: "object", properties: { title: { type: "string" }, person: { type: "string" }, due: { type: "string" }, client: { type: "string" }, item_key: { type: "string" } }, required: ["title", "person"], additionalProperties: false },
        status: () => "Assigning it…",
        run: async (input) => {
          const [{ openMeeting }, { addTodo, personNamed, markItem }] = await Promise.all([import("@/lib/csuite/load"), import("@/lib/csuite/server")]);
          const who = await personNamed(ctx.db, clip(input.person, 80));
          if ("error" in who) return { done: false, note: who.error };
          let clientId: string | null = null;
          if (input.client) {
            const safe = clip(input.client, 80).replace(/[%_,()]/g, " ").trim();
            const { data } = await ctx.db.from("clients").select("id").ilike("name", `%${safe}%`).is("archived_at", null).limit(1).maybeSingle();
            clientId = (data?.id as string | undefined) ?? null;
          }
          const m = await openMeeting(ctx.db);
          const due = /^\d{4}-\d{2}-\d{2}$/.test(String(input.due ?? "")) ? String(input.due) : new Date(Date.now() + 7 * 86_400_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
          const key = clip(input.item_key, 200) || null;
          await addTodo(ctx.db, ctx.admin, ctx.me, { meetingId: m?.id ?? null, title: clip(input.title, 240), assigneeId: who.id, dueOn: due, clientId, itemKey: key });
          if (m && key) await markItem(ctx.db, m.id, key, "discuss", `Assigned to ${who.name}: ${clip(input.title, 200)}`);
          return { done: true, who: who.name, due };
        },
      },
      {
        name: "upsell_opportunities",
        description: "Clients ready for another service: beating their KPI on one line without a fitting other line, industry fit, growing spend, or they asked about it. Each with the offer and why. For the review, a sales push, or before draft_client_emails.",
        input_schema: { type: "object", properties: { limit: { type: "integer" } }, additionalProperties: false },
        status: () => "Looking for upsells…",
        run: async (input) => {
          const { loadReview } = await import("@/lib/csuite/load");
          const r = await loadReview(ctx.db, ctx.admin);
          const n = Math.min(30, Math.max(1, Number(input.limit) || 12));
          return { upsells: r.upsells.slice(0, n).map((u) => ({ client: u.client, service: u.service, offer: u.offer, why: u.why.slice(0, 3) })), href: "/kpis?p=review&step=upsell" };
        },
      },
    );
  }
  tools.push(
    {
      name: "draft_client_emails",
      description: `Drafts emails to clients for the person to send themselves (never sent from here): one per client named, or every client on the upsell list (from_upsells: true, optionally limit). kind: ${DRAFT_KINDS.join(", ")}. purpose: what the emails are for, in their words. They land on the person's Overview under "Emails ready to send" (Open draft puts one in their Gmail). Say how many were drafted and where.`,
      input_schema: {
        type: "object",
        properties: {
          clients: { type: "array", items: { type: "string" }, description: "Client names" },
          from_upsells: { type: "boolean" },
          limit: { type: "integer" },
          kind: { type: "string", enum: [...DRAFT_KINDS] },
          purpose: { type: "string" },
        },
        required: ["kind", "purpose"],
        additionalProperties: false,
      },
      status: () => "Drafting the emails…",
      run: async (input) => {
        const { draftBulk } = await import("@/lib/email-drafts/server");
        const kind = (DRAFT_KINDS as readonly string[]).includes(String(input.kind)) ? (input.kind as DraftKind) : "other";
        let list: { id: string; name: string; points?: string[] }[] = [];
        if (input.from_upsells === true && exec) {
          const { loadReview } = await import("@/lib/csuite/load");
          const r = await loadReview(ctx.db, ctx.admin);
          list = r.upsells.slice(0, Math.min(25, Number(input.limit) || 12)).map((u) => ({ id: u.clientId, name: u.client, points: [u.offer, ...u.why.slice(0, 2)] }));
        } else {
          const names = (Array.isArray(input.clients) ? input.clients : []).map((x) => clip(x, 80)).filter(Boolean).slice(0, 25);
          if (!names.length) return { drafted: 0, note: "Which clients? Name them, or use from_upsells." };
          const { data } = await ctx.db.from("clients").select("id, name").is("archived_at", null).in("status", [...LIVE]);
          const { foldMatch } = await import("@/lib/search-fold");
          for (const n of names) {
            const hit = ((data ?? []) as { id: string; name: string }[]).find((c) => foldMatch(c.name, n));
            if (hit && !list.some((x) => x.id === hit.id)) list.push(hit);
          }
          if (!list.length) return { drafted: 0, note: "None of those are clients you can see." };
        }
        const r = await draftBulk(ctx.admin, ctx.me, { clients: list, kind, purpose: clip(input.purpose, 800), sourceKind: kind === "upsell" ? "upsell" : "assistant" });
        return { drafted: r.drafted.length, emails: r.drafted.map((d) => ({ client: d.client, subject: d.subject })), where: "Their Overview, Emails ready to send", href: "/pipeline#emails-ready", note: r.note };
      },
    },
    {
      name: "my_email_drafts",
      description: "The client emails drafted for this person and waiting to go out (from calls, notes, promises, Slack and email, or drafted on request): client, subject, why. Scan: true reads their clients again for new ones first (takes a while).",
      input_schema: { type: "object", properties: { scan: { type: "boolean" } }, additionalProperties: false },
      status: (input) => (input.scan ? "Reading your clients' calls and messages…" : "Reading your drafts…"),
      run: async (input) => {
        const { myDrafts, scanForPerson } = await import("@/lib/email-drafts/server");
        const added = input.scan === true ? (await scanForPerson(ctx.admin, ctx.me, { max: 10 })).added : undefined;
        const ds = await myDrafts(ctx.db, ctx.me.id);
        return { new: added, drafts: ds.map((d) => ({ client: d.clients?.name, kind: d.kind, subject: d.subject, why: d.reason, opened: d.status === "opened" })), href: "/pipeline#emails-ready" };
      },
    },
  );
  return tools;
}
