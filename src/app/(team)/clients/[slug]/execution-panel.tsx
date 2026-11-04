"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Markdown } from "@/components/markdown";
import type { ClientTask, ExecutionPlan, PlanRow } from "@/lib/execution-plan";
import type { KickoffRow, SlackMessage } from "@/lib/kickoff";
import { PHASE_LABEL, ROLE_LABEL, type OwnerRole, type TaskPhase } from "@/lib/task-graph";
import { pushParams, useParam } from "@/lib/url-state";
import { buildPlanNow, reopenPlan, saveKickoffText, saveTeamNotes, sendHeldNow, sendKickoffNow, setTaskStatus, signOffPlanNow, writeKickoffAnyway } from "./execution-actions";

// The client's plan, from the strategy review to the work: the messages in their Slack channel ("Meet your team", then
// the go-to-market and 90-day roadmap), the final execution plan (the go-to-market strategies with the team's notes
// folded in, signed off by a buyer or lead), and its tasks as a timeline: who owns each, when it's due, what it waits
// on and what it holds up.

type Props = {
  clientId: string;
  meId: string;
  plan: PlanRow | null;
  gate: string[];
  tasks: ClientTask[];
  kickoff: KickoffRow | null;
  messages: SlackMessage[];
  can: { decide: boolean; lead: boolean };
  hasChannel: boolean;
};

const day = (d: string) => new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export function ExecutionPanel(p: Props) {
  return (
    <div className="grid gap-6">
      {/* Keyed on status, so a draft that just landed fills the editor */}
      <KickoffCard key={p.kickoff?.status ?? "none"} {...p} />
      <PlanCard key={p.plan?.status ?? "none"} {...p} />
      {p.tasks.length > 0 && <Timeline {...p} />}
      <SlackHistory {...p} />
    </div>
  );
}

const KIND_NAME: Record<SlackMessage["kind"], string> = { meet_team: "Meet your team", team_change: "Team update", roadmap: "Go-to-market and 90-day roadmap" };

/** What we've posted in their Slack channel at onboarding, and anything held while client outreach is off */
function SlackHistory({ clientId, messages, can, hasChannel }: Props) {
  if (!messages.length)
    return (
      <Shell title="In their Slack channel">
        <p className="text-sm text-muted">&ldquo;Meet your team&rdquo; posts on its own once their Slack channel is connected and their team is assigned (a buyer for each ad platform, a maker for creative): who&apos;s on it, what we do for them and what happens next.{!hasChannel && " Their channel isn't connected yet."}</p>
      </Shell>
    );
  return (
    <Shell title="In their Slack channel" badge={<Pill tone="muted">{messages.length}</Pill>}>
      <ul className="grid gap-3">
        {messages.map((m) => (
          <HeldOrSent key={m.id} m={m} clientId={clientId} canSend={can.decide && hasChannel} />
        ))}
      </ul>
    </Shell>
  );
}

function HeldOrSent({ m, clientId, canSend }: { m: SlackMessage; clientId: string; canSend: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(m.text);
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const held = m.status !== "sent";
  return (
    <li className="grid gap-2 rounded-[16px] border border-line bg-bg p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{KIND_NAME[m.kind]}</span>
        {m.status === "sent" ? (
          <Pill tone="ok">
            Sent {m.sentAt ? day(m.sentAt) : ""}
            {m.sentBy ? ` by ${m.sentBy}` : m.auto ? " on its own" : ""}
          </Pill>
        ) : m.status === "held" ? (
          <Pill tone="warn">Held: client outreach is off</Pill>
        ) : (
          <Pill tone="bad">Didn&apos;t go</Pill>
        )}
      </div>
      {held ? (
        <>
          <textarea data-chat value={text} onChange={(e) => setText(e.target.value)} rows={8} disabled={!canSend} className="w-full rounded-[12px] border border-line bg-surface p-3 text-[14px] leading-relaxed outline-none focus:border-brand-text/60 disabled:opacity-80" />
          {m.error && <p className="text-xs text-bad">{m.error}</p>}
          {canSend && (
            <div>
              <button
                disabled={busy || !text.trim()}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const r = await sendHeldNow(clientId, m.id, text);
                    if (!r.ok) setError(r.error);
                    router.refresh();
                  })
                }
                className="min-h-11 rounded-full bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50 md:min-h-9"
              >
                {busy ? "Sending…" : "Send it now"}
              </button>
            </div>
          )}
          {error && <p className="text-xs text-bad">{error}</p>}
        </>
      ) : (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">What it said</summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{m.text}</p>
        </details>
      )}
    </li>
  );
}

function Shell({ title, badge, children, tone = "line" }: { title: string; badge?: React.ReactNode; children: React.ReactNode; tone?: "line" | "brand" }) {
  return (
    <section className={`relative grid gap-4 overflow-hidden rounded-[20px] border bg-surface p-5 md:p-6 ${tone === "brand" ? "border-brand/40" : "border-line"}`}>
      {tone === "brand" && <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-brand opacity-[0.1] blur-3xl" />}
      <div className="relative flex flex-wrap items-center gap-2">
        <h2 className="font-heading text-[18px] tracking-tight">{title}</h2>
        {badge}
      </div>
      <div className="relative grid gap-4">{children}</div>
    </section>
  );
}

const Pill = ({ tone, children }: { tone: "ok" | "warn" | "bad" | "brand" | "muted"; children: React.ReactNode }) => (
  <span className={`rounded-full px-2.5 py-0.5 text-[11.5px] ${tone === "ok" ? "bg-ok-soft text-ok" : tone === "warn" ? "bg-warn-soft text-warn" : tone === "bad" ? "bg-bad-soft text-bad" : tone === "brand" ? "bg-brand/10 text-brand-text" : "bg-surface-2 text-muted"}`}>{children}</span>
);

/** The kickoff message: what it's waiting on, then a draft to edit and send, then what was sent */
function KickoffCard({ clientId, kickoff, can, hasChannel }: Props) {
  const router = useRouter();
  const [text, setText] = useState(kickoff?.text ?? "");
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const saved = useRef(kickoff?.text ?? "");
  // Edits save on their own, a moment after typing stops
  useEffect(() => {
    if (kickoff?.status !== "draft" || text === saved.current) return;
    const t = setTimeout(() => {
      saved.current = text;
      void saveKickoffText(clientId, text);
    }, 1200);
    return () => clearTimeout(t);
  }, [text, clientId, kickoff?.status]);

  if (kickoff?.status === "sent")
    return (
      <Shell title="Go-to-market and 90-day roadmap" badge={<Pill tone="ok">Sent{kickoff.sentAt ? ` ${day(kickoff.sentAt)}` : ""}</Pill>}>
        <p className="text-sm text-muted">
          Posted in their Slack channel{kickoff.sentBy ? ` by ${kickoff.sentBy}` : ""}
          {kickoff.sentAs === "app" ? " (as the Kaizen app)" : ""}.
        </p>
        <details className="rounded-[14px] border border-line bg-bg p-4 text-sm">
          <summary className="cursor-pointer text-muted">What it said</summary>
          <p className="mt-3 whitespace-pre-wrap leading-relaxed">{kickoff.text}</p>
        </details>
      </Shell>
    );

  const missing = kickoff?.missing ?? [];
  const onlyIntake = missing.length === 1 && missing[0] === "the intake form";
  if (!kickoff || kickoff.status === "waiting" || kickoff.status === "failed")
    return (
      <Shell title="Go-to-market and 90-day roadmap" badge={<Pill tone="muted">Not yet</Pill>}>
        <p className="text-sm leading-relaxed text-muted">The message in their Slack channel with their go-to-market strategy: what we&apos;re doing first on each platform and their first 90 days (their team was introduced earlier, in &ldquo;Meet your team&rdquo;). It&apos;s written once the intake form is in, they&apos;ve approved their plan and the team has had its internal strategy meeting about them. A buyer or lead reviews it and sends it; it never goes on its own.</p>
        {missing.length > 0 && (
          <p className="text-sm">
            <span className="text-faint">Waiting on: </span>
            {missing.join(" · ")}
          </p>
        )}
        {kickoff?.status === "failed" && <p className="text-xs text-bad">{kickoff.error ?? "It couldn't be written."} It tries again on its own.</p>}
        {onlyIntake && can.lead && (
          <div>
            <button
              disabled={busy}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await writeKickoffAnyway(clientId);
                  if (!r.ok) setError(r.error);
                  router.refresh();
                })
              }
              className="min-h-11 rounded-full border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-50 md:min-h-9"
            >
              {busy ? "Writing it…" : "Write it without the intake form"}
            </button>
          </div>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
      </Shell>
    );

  if (kickoff.status === "writing")
    return (
      <Shell title="Go-to-market and 90-day roadmap" badge={<Pill tone="brand">Writing</Pill>}>
        <div className="h-1 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-1/3 animate-[ai-sweep_2.4s_ease-in-out_infinite] rounded-full bg-brand" />
        </div>
      </Shell>
    );

  return (
    <Shell title="Go-to-market and 90-day roadmap" tone="brand" badge={<Pill tone="brand">Ready to send{kickoff.forced ? " · written without the intake form" : ""}</Pill>}>
      <p className="text-sm text-muted">For their Slack channel. Edit anything, then send it. It goes out from you (or as the Kaizen app if your Slack isn&apos;t connected).</p>
      <textarea data-chat value={text} onChange={(e) => setText(e.target.value)} rows={14} disabled={!can.decide} className="min-h-[280px] w-full resize-y rounded-[14px] border border-line bg-bg p-4 text-[15px] leading-relaxed outline-none focus:border-brand-text/60 disabled:opacity-80" />
      {!hasChannel && <p className="text-xs text-warn">This client has no Slack channel connected: add it under Team &amp; setup to send.</p>}
      {can.decide ? (
        <div className="flex flex-wrap items-center gap-2">
          {!sure ? (
            <button disabled={busy || !hasChannel || !text.trim()} onClick={() => setSure(true)} className="min-h-11 rounded-full bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50">
              Send to their channel
            </button>
          ) : (
            <>
              <button
                disabled={busy}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const r = await sendKickoffNow(clientId, text);
                    setSure(false);
                    if (!r.ok) setError(r.error);
                    router.refresh();
                  })
                }
                className="min-h-11 rounded-full bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-50"
              >
                {busy ? "Sending…" : "Yes, send it now"}
              </button>
              <button onClick={() => setSure(false)} className="min-h-11 rounded-full px-4 text-sm text-muted hover:text-fg">
                Not yet
              </button>
            </>
          )}
        </div>
      ) : (
        <p className="text-xs text-faint">The client&apos;s buyer or a lead sends it.</p>
      )}
      {error && <p className="text-xs text-bad">{error}</p>}
    </Shell>
  );
}

/** The final execution plan: waiting, being written, a draft to review and sign off, or signed off */
function PlanCard({ clientId, plan, gate, can }: Props) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const [open, setOpen] = useState(false);
  const [now] = useState(() => Date.now());
  const building = plan?.status === "building" && plan.startedAt && now - Date.parse(plan.startedAt) < 20 * 60_000;
  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [building, router]);
  const run = (f: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const r = await f();
      if (!r.ok) setError(r.error ?? "Something went wrong.");
      router.refresh();
    });
  const x = plan?.plan as ExecutionPlan | null | undefined;
  const status = plan?.status ?? "waiting";
  const badge =
    status === "final" ? <Pill tone="ok">Signed off{plan?.signedOffBy ? ` by ${plan.signedOffBy}` : ""}{plan?.signedOffAt ? `, ${day(plan.signedOffAt)}` : ""}</Pill> : status === "draft" ? <Pill tone="warn">Draft · sign it off to start the tasks</Pill> : building ? <Pill tone="brand">Writing</Pill> : <Pill tone="muted">Not yet</Pill>;

  return (
    <Shell title="Execution plan" badge={badge}>
      <p className="text-sm leading-relaxed text-muted">After the client approves their plan, the team reviews the go-to-market strategies (on the internal strategy call or in notes here). Those notes are folded into one plan: what we launch, the testing, and the 30/60/90 days. Signing it off turns it into the tasks below.</p>

      {status !== "final" && (gate.length > 0 && !x) && (
        <p className="text-sm">
          <span className="text-faint">Waiting on: </span>
          {gate.join(" · ")}
        </p>
      )}

      {building && (
        <div className="h-1 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full w-1/3 animate-[ai-sweep_2.4s_ease-in-out_infinite] rounded-full bg-brand" />
        </div>
      )}

      {x && !building && (
        <div className="grid gap-4">
          <p className="text-[15px] leading-relaxed">{x.summary}</p>
          <div className="grid gap-3 md:grid-cols-3">
            {x.phases.map((ph) => (
              <div key={ph.window} className="grid content-start gap-2 rounded-[16px] border border-line bg-bg p-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-brand-text">{PHASE_LABEL[ph.window]}</p>
                <p className="text-sm font-medium leading-snug">{ph.goal}</p>
                <ul className="grid gap-1 text-[13px] leading-relaxed text-muted">
                  {ph.items.map((it) => (
                    <li key={it}>• {it}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          {x.folded.length > 0 && (
            <div className="rounded-[14px] border border-ok/30 bg-ok-soft/30 p-4">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ok">From the team&apos;s review</p>
              <ul className="grid gap-1 text-[13px] text-muted">
                {x.folded.map((f) => (
                  <li key={f}>• {f}</li>
                ))}
              </ul>
            </div>
          )}
          {x.open.length > 0 && (
            <div className="rounded-[14px] border border-warn/30 bg-warn-soft/30 p-4">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-warn">Still to confirm</p>
              <ul className="grid gap-1 text-[13px] text-muted">
                {x.open.map((f) => (
                  <li key={f}>• {f}</li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <button onClick={() => setOpen((o) => !o)} className="min-h-11 rounded-full border border-line px-4 text-sm text-muted hover:text-fg md:min-h-9">
              {open ? "Hide the platforms" : "What we launch on each platform"}
            </button>
          </div>
          {open && (
            <div className="min-w-0 rounded-[14px] border border-line bg-bg p-4 [overflow-wrap:anywhere] md:p-5">
              <Markdown text={x.platforms.map((pl) => `### ${pl.platform === "meta" ? "Meta" : "Google Ads"}\n**Launch**\n${pl.launch.map((l) => `- ${l}`).join("\n")}\n\n**Audiences**\n${pl.audiences.map((l) => `- ${l}`).join("\n")}\n\n**Creative**\n${pl.creative.map((l) => `- ${l}`).join("\n")}\n\n**Testing**\n${pl.testing.map((l) => `- ${l}`).join("\n")}\n\n**Budget:** ${pl.budget}`).join("\n\n")} />
            </div>
          )}
        </div>
      )}

      {status !== "final" && !building && (
        <div className="grid gap-2">
          <label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint" htmlFor="team-notes">
            The team&apos;s review: keep, change, audiences, angles
          </label>
          <textarea id="team-notes" data-chat value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder="e.g. Keep the Build Your Own angle first. Drop the 55+ audience. Test the gift box before Black Friday." className="w-full rounded-[14px] border border-line bg-bg p-3 text-[15px] leading-relaxed outline-none focus:border-brand-text/60" />
          <p className="text-xs text-faint">An internal call about them is read on its own too and folded in.</p>
          <div className="flex flex-wrap gap-2">
            <button disabled={busy || !notes.trim()} onClick={() => run(() => saveTeamNotes(clientId, notes, Boolean(x) || gate.length === 0))} className="min-h-11 rounded-full bg-fg px-4 text-sm text-bg disabled:opacity-50 md:min-h-9">
              {x ? "Fold into the plan" : gate.length ? "Save the notes" : "Save and write the plan"}
            </button>
            {!x && gate.length === 0 && (
              <button disabled={busy} onClick={() => run(() => buildPlanNow(clientId))} className="min-h-11 rounded-full border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-50 md:min-h-9">
                Write it now
              </button>
            )}
            {status === "draft" && can.decide && (
              <button disabled={busy} onClick={() => run(() => signOffPlanNow(clientId))} className="min-h-11 rounded-full bg-ok px-4 text-sm font-medium text-white disabled:opacity-50 md:min-h-9">
                Sign off the plan
              </button>
            )}
          </div>
        </div>
      )}
      {status === "final" && can.lead && (
        <div>
          <button disabled={busy} onClick={() => run(() => reopenPlan(clientId))} className="min-h-11 rounded-full border border-line px-4 text-sm text-muted hover:text-fg disabled:opacity-50 md:min-h-9">
            Reopen to change it
          </button>
        </div>
      )}
      {(error || (plan?.status === "failed" && plan.error)) && <p className="text-xs text-bad">{error ?? plan?.error}</p>}
    </Shell>
  );
}

const LANE: Record<string, string> = {
  meta_buyer: "bg-brand",
  google_buyer: "bg-ok",
  graphic_designer: "bg-warn",
  video_editor: "bg-warn",
  copywriter: "bg-warn",
  head_of_creative: "bg-warn",
  coordinator: "bg-fg",
  lead: "bg-fg",
  tracking: "bg-muted",
  client: "bg-faint",
};

/** The tasks as a vertical timeline, by phase, with a lane per role (filtered in the address, so back undoes it) */
function Timeline({ clientId, tasks, meId, can }: Props) {
  const router = useRouter();
  const lane = useParam("lane");
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const roles = [...new Set(tasks.map((t) => t.ownerRole))];
  const shown = tasks.filter((t) => !lane || t.ownerRole === lane);
  const doneN = tasks.filter((t) => t.status === "done").length;
  const t0 = today();
  const move = (id: string, status: "in_progress" | "done" | "ready") =>
    start(async () => {
      setError(null);
      const r = await setTaskStatus(clientId, id, status);
      if (!r.ok) setError(r.error);
      router.refresh();
    });
  return (
    <Shell title="Tasks" badge={<Pill tone={doneN === tasks.length ? "ok" : "muted"}>{doneN} of {tasks.length} done</Pill>}>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-ok transition-[width] duration-700" style={{ width: `${Math.round((doneN / Math.max(1, tasks.length)) * 100)}%` }} />
      </div>
      <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        <button onClick={() => pushParams({ lane: null })} className={`min-h-10 shrink-0 rounded-full px-3.5 text-[13px] ${!lane ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
          Everyone
        </button>
        {roles.map((r) => (
          <button key={r} onClick={() => pushParams({ lane: r })} className={`flex min-h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] ${lane === r ? "bg-fg text-bg" : "border border-line text-muted hover:text-fg"}`}>
            <span className={`h-2 w-2 rounded-full ${LANE[r] ?? "bg-muted"}`} />
            {ROLE_LABEL[r as OwnerRole] ?? r}
          </button>
        ))}
      </div>
      {(["setup", "d30", "d60", "d90"] as TaskPhase[]).map((ph) => {
        const list = shown.filter((t) => t.phase === ph);
        if (!list.length) return null;
        return (
          <div key={ph} className="grid gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{PHASE_LABEL[ph]}</p>
            <ol className="relative grid gap-0 border-l border-line pl-5">
              {list.map((t) => {
                const late = t.dueOn && t.status !== "done" && t.dueOn < t0;
                const mine = t.ownerId === meId || can.decide;
                return (
                  <li key={t.id} className="relative pb-5 last:pb-1">
                    <span className={`absolute -left-[27px] top-1 grid h-3.5 w-3.5 place-items-center rounded-full ring-4 ring-surface ${t.status === "done" ? "bg-ok" : t.status === "blocked" ? "bg-surface-2 ring-surface" : t.status === "in_progress" ? "bg-brand" : (LANE[t.ownerRole] ?? "bg-muted")}`} />
                    <div className="grid gap-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className={`text-[14.5px] font-medium leading-snug ${t.status === "done" ? "text-muted line-through decoration-faint" : ""}`}>{t.title}</span>
                        {t.status === "done" ? <Pill tone="ok">{t.doneHow === "auto" ? "Done on its own" : "Done"}</Pill> : t.status === "blocked" ? <Pill tone="muted">Waiting</Pill> : t.status === "in_progress" ? <Pill tone="brand">In progress</Pill> : <Pill tone={late ? "bad" : "warn"}>{late ? "Late" : "Ready"}</Pill>}
                      </div>
                      <p className="text-[12.5px] text-muted">
                        <span className="text-faint">{t.owner}</span>
                        {t.dueOn && <span className={late ? " text-bad" : ""}> · due {day(t.dueOn)}</span>}
                      </p>
                      {t.status === "blocked" && t.waitingOn.length > 0 && <p className="text-[12.5px] text-muted">Waiting on: {t.waitingOn.map((w) => `${w.title} (${w.who})`).join(" · ")}</p>}
                      {t.status !== "done" && t.status !== "blocked" && t.holdingUp.length > 0 && <p className="text-[12.5px] text-warn">Holding up: {t.holdingUp.map((w) => `${w.title} (${w.who})`).join(" · ")}</p>}
                      {t.detail && t.status !== "done" && <p className="text-[12.5px] leading-relaxed text-faint">{t.detail}</p>}
                      {mine && t.status !== "done" && t.status !== "blocked" && !(t.ownerRole === "client") && (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {t.status === "ready" && (
                            <button disabled={busy} onClick={() => move(t.id, "in_progress")} className="min-h-10 rounded-full border border-line px-3 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-8">
                              Start
                            </button>
                          )}
                          <button disabled={busy} onClick={() => move(t.id, "done")} className="min-h-10 rounded-full bg-ok px-3 text-[12.5px] font-medium text-white disabled:opacity-50 md:min-h-8">
                            Mark done
                          </button>
                        </div>
                      )}
                      {can.decide && t.status === "done" && t.doneHow === "manual" && (
                        <div className="mt-1">
                          <button disabled={busy} onClick={() => move(t.id, "ready")} className="min-h-10 rounded-full px-2 text-[12px] text-faint hover:text-fg md:min-h-8">
                            Undo
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })}
      {error && <p className="text-xs text-bad">{error}</p>}
    </Shell>
  );
}
