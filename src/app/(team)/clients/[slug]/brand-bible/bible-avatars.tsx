"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { BibleChange } from "@/lib/bible-governance";
import { avatarHint, BIBLE_APPROVERS, BIBLE_EDITORS, type AvatarHint, type AvatarResults, type ProposedAvatar } from "@/lib/bible-avatars";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { toast } from "@/components/toasts";
import { decideBibleChange, proposeBibleChange } from "../brand-bible-actions";
import { Layer } from "../layer";

// Avatar governance on the Bible page: how each avatar's ads are doing, "Propose a change" for anyone on the client,
// and the approvers' queue (approve applies it to the Bible, reject keeps a record). The proposal sheet and a proposal
// opened from a notification live in the address (?propose=, ?avatar=, ?change=), so back closes them.

export type Governance = { canApprove: boolean; changes: BibleChange[]; results: Record<string, AvatarResults> };

const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" }).format(new Date(iso));

const TONE: Record<AvatarHint["tone"], string> = {
  great: "bg-ok-soft text-ok",
  work: "bg-warn-soft text-warn",
  failing: "bg-bad-soft text-bad",
  early: "bg-surface-2 text-muted",
  none: "border border-line text-faint",
};

/** How the ads made for one avatar are doing, in a word and a line */
export function AvatarPerformance({ results }: { results: AvatarResults | null }) {
  const h = avatarHint(results);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-surface/60 px-3 py-2">
      <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${TONE[h.tone]}`}>{h.label}</span>
      <span className="min-w-0 flex-1 text-[12px] leading-snug text-muted">{h.detail}</span>
    </div>
  );
}

/** Under each avatar: its results, and the way to propose changing or retiring it */
export function AvatarFooter({ name, retired, results }: { name: string; retired: string | null; results: AvatarResults | null }) {
  if (retired) return <p className="text-[12px] text-faint">Retired {retired}. Kept here for the record; briefs don&apos;t use it.</p>;
  return (
    <div className="grid gap-2">
      <AvatarPerformance results={results} />
      <div className="flex flex-wrap gap-1">
        <button type="button" onClick={() => pushParams({ propose: "change", avatar: name })} className="h-11 rounded-full px-2 text-[12.5px] text-muted hover:text-fg md:h-8">
          Propose a change
        </button>
        <button type="button" onClick={() => pushParams({ propose: "retire", avatar: name })} className="h-11 rounded-full px-2 text-[12.5px] text-muted hover:text-bad md:h-8">
          Propose retiring it
        </button>
      </div>
    </div>
  );
}

/** Who edits and who approves, said once at the top of the avatars, with the way to propose a new one */
export function AvatarGovernanceBar({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[18px] border border-line bg-bg/40 px-4 py-3">
      <p className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-muted">
        <span className="text-fg">Avatars change only by approval.</span> Anyone on the client proposes; {BIBLE_APPROVERS.toLowerCase()} approve. {canEdit ? "You can edit this Bible." : `${BIBLE_EDITORS} edit it; you can read it and propose.`}
      </p>
      <button type="button" onClick={() => pushParams({ propose: "add", avatar: null })} className="h-11 shrink-0 rounded-full bg-fg px-4 text-[13px] text-bg max-md:w-full md:h-9">
        + Propose an avatar
      </button>
    </div>
  );
}

const KIND: Record<BibleChange["kind"], string> = {
  avatar_add: "New avatar",
  avatar_change: "Change an avatar",
  avatar_retire: "Retire an avatar",
  question_answer: "Answer to an open question",
};

function ChangeCard({ c, canApprove, client, focused, onDecided }: { c: BibleChange; canApprove: boolean; client: { id: string; slug: string }; focused: boolean; onDecided: (id: string, status: BibleChange["status"] | "pending") => void }) {
  const router = useRouter();
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const [busy, start] = useTransition();
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focused]);
  const decide = (approve: boolean) => {
    if (!approve && !note.trim()) return setRejecting(true);
    // Instant: the card moves to the record at once, and comes back if it didn't go through
    onDecided(c.id, approve ? "approved" : "rejected");
    start(async () => {
      const r = await decideBibleChange(client.id, client.slug, c.id, approve, note);
      if (!r.ok) {
        onDecided(c.id, "pending");
        toast({ tone: "bad", title: r.error });
        return;
      }
      toast({ tone: "ok", title: approve ? (r.applied ? "Approved and written into the Bible" : "Approved. The Bible keeper asked a follow-up in the question.") : "Rejected. The proposer hears why." });
      router.refresh();
    });
  };
  const title = c.kind === "avatar_add" ? c.proposed?.name : c.kind === "question_answer" ? null : c.avatar;
  return (
    <li ref={ref} className={`grid gap-3 rounded-[18px] border bg-bg/60 p-4 ${focused ? "border-brand/50 ring-2 ring-brand/20" : "border-line"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${c.kind === "avatar_retire" ? "bg-bad-soft text-bad" : c.kind === "avatar_add" ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{KIND[c.kind]}</span>
        {title && <span className="font-heading text-[15px]">{title}</span>}
        {c.kind === "avatar_change" && c.proposed && c.proposed.name !== c.avatar && <span className="text-[13px] text-muted">→ {c.proposed.name}</span>}
        <span className="ml-auto text-[11.5px] text-faint">
          {c.proposedBy ?? "Someone"} · {fmt(c.createdAt)}
        </span>
      </div>
      {c.answer && <p className="whitespace-pre-wrap rounded-[12px] bg-surface-2/60 px-3 py-2 text-[13.5px] leading-relaxed">{c.answer}</p>}
      {c.reason && (
        <p className="text-[13.5px] leading-relaxed">
          <span className="text-faint">Why: </span>
          {c.reason}
        </p>
      )}
      {c.evidence && (
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted">
          <span className="text-faint">Evidence: </span>
          {c.evidence}
        </p>
      )}
      {c.proposed && (
        <details className="rounded-[12px] border border-line px-3 py-2">
          <summary className="flex min-h-9 cursor-pointer list-none items-center text-[12.5px] text-muted max-md:min-h-11">
            The profile as proposed ({c.proposed.tier.toLowerCase()})
          </summary>
          <p className="whitespace-pre-wrap pt-2 text-[13px] leading-relaxed">{c.proposed.body}</p>
        </details>
      )}
      {c.status === "pending" ? (
        canApprove ? (
          <div className="grid gap-2">
            {rejecting && (
              <input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && decide(false)}
                placeholder="Why not? The proposer sees this."
                className="h-11 rounded-full border border-line bg-bg px-4 text-[16px] outline-none focus:border-faint md:h-9 md:text-[13px]"
              />
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" disabled={busy} onClick={() => decide(true)} className="h-11 flex-1 rounded-full bg-ok px-4 text-[13px] font-medium text-white disabled:opacity-50 md:h-9 md:flex-initial">
                Approve and apply
              </button>
              <button type="button" disabled={busy} onClick={() => decide(false)} className="h-11 flex-1 rounded-full border border-line px-4 text-[13px] text-muted hover:text-bad disabled:opacity-50 md:h-9 md:flex-initial">
                {rejecting ? "Reject with this note" : "Reject"}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[12px] text-faint">Waiting on {BIBLE_APPROVERS.toLowerCase()}.</p>
        )
      ) : (
        <p className="text-[12px] text-faint">
          <span className={c.status === "approved" ? "text-ok" : "text-bad"}>{c.status === "approved" ? "Approved" : "Rejected"}</span>
          {c.decidedBy && ` by ${c.decidedBy}`}
          {c.decidedAt && ` · ${fmt(c.decidedAt)}`}
          {c.note && `: ${c.note}`}
        </p>
      )}
    </li>
  );
}

/** The approvers' queue (every proposal waiting) and the record of what was decided */
export function ChangesPanel({ gov, client }: { gov: Governance; client: { id: string; slug: string } }) {
  const focus = useParam("change");
  const wantAll = useParam("changes") === "1";
  const [local, setLocal] = useState<Record<string, BibleChange["status"]>>({});
  const changes = gov.changes.map((c) => (local[c.id] ? { ...c, status: local[c.id] } : c));
  const pending = changes.filter((c) => c.status === "pending");
  const done = changes.filter((c) => c.status !== "pending");
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (wantAll) ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [wantAll]);
  if (!changes.length) return null;
  const decided = (id: string, status: BibleChange["status"]) => setLocal((m) => ({ ...m, [id]: status }));
  const focusDone = Boolean(focus && done.some((c) => c.id === focus));
  return (
    <section ref={ref} id="changes" className="scroll-mt-32 rounded-[24px] border border-line bg-surface p-5 md:p-8">
      <header className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-heading text-[22px] leading-tight md:text-[26px]">Proposed changes</h2>
        {pending.length > 0 && <span className="tabular rounded-full bg-warn-soft px-2 py-0.5 text-[11px] text-warn">{pending.length} waiting</span>}
        <span className="w-full text-[12.5px] text-faint">Approved by {BIBLE_APPROVERS.toLowerCase()}. Nothing is deleted: a replaced or retired avatar stays in the Bible, labeled retired with the date.</span>
      </header>
      {pending.length > 0 ? (
        <ul className="grid gap-3">
          {pending.map((c) => (
            <ChangeCard key={c.id} c={c} canApprove={gov.canApprove} client={client} focused={focus === c.id} onDecided={decided} />
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">Nothing waiting.</p>
      )}
      {done.length > 0 && (
        <details open={focusDone} className="group mt-4 rounded-[18px] border border-line bg-bg/40 px-4 py-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] text-muted">
            Decided <span className="tabular rounded-full bg-surface-2 px-2 py-0.5 text-[11px]">{done.length}</span>
            <span className="ml-auto text-[12px] text-faint group-open:hidden">Show</span>
          </summary>
          <ul className="grid gap-3 pt-2">
            {done.map((c) => (
              <ChangeCard key={c.id} c={c} canApprove={false} client={client} focused={focus === c.id} onDecided={decided} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const TIERS: ProposedAvatar["tier"][] = ["Hypothesis", "Likely", "Proven"];

/** The proposal sheet: add an avatar, change one, or retire one, with why and the evidence */
export function ProposeAvatarSheet({ client, avatars, results }: { client: { id: string; slug: string }; avatars: { name: string; tier: string | null; body: string }[]; results: Record<string, AvatarResults> }) {
  const router = useRouter();
  const mode = useParam("propose");
  const named = useParam("avatar");
  const kind = mode === "add" || mode === "change" || mode === "retire" ? mode : null;
  const current = named ? (avatars.find((a) => a.name === named) ?? null) : null;
  if (!kind || (kind !== "add" && !current)) return null;
  return <Sheet key={`${kind}:${named ?? ""}`} kind={kind} client={client} current={current} results={current ? (results[current.name] ?? null) : null} onDone={() => router.refresh()} />;
}

function Sheet({ kind, client, current, results, onDone }: { kind: "add" | "change" | "retire"; client: { id: string; slug: string }; current: { name: string; tier: string | null; body: string } | null; results: AvatarResults | null; onDone: () => void }) {
  const hint = results ? avatarHint(results) : null;
  const [name, setName] = useState(current?.name ?? "");
  const [tier, setTier] = useState<ProposedAvatar["tier"]>((TIERS.find((t) => t.toLowerCase() === current?.tier?.toLowerCase()) ?? "Hypothesis") as ProposedAvatar["tier"]);
  const [body, setBody] = useState(current?.body ?? "");
  const [reason, setReason] = useState("");
  const [evidence, setEvidence] = useState(hint && hint.tone !== "none" ? `Ads tagged with this avatar: ${hint.detail}` : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const close = () => closeParams("propose", "avatar");
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && closeParams("propose", "avatar");
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);
  const send = () =>
    start(async () => {
      setError(null);
      const proposed = { name, tier, body };
      const r = await proposeBibleChange(
        client.id,
        client.slug,
        kind === "add" ? { kind: "avatar_add", proposed, reason, evidence } : kind === "change" ? { kind: "avatar_change", avatar: current!.name, proposed, reason, evidence } : { kind: "avatar_retire", avatar: current!.name, reason, evidence },
      );
      if (!r.ok) return setError(r.error);
      toast({ tone: "ok", title: "Proposed. The approvers have it." });
      close();
      onDone();
    });
  const heading = kind === "add" ? "Propose a new avatar" : kind === "change" ? `Propose a change to ${current?.name}` : `Propose retiring ${current?.name}`;
  const field = "w-full rounded-[14px] border border-line bg-bg px-3.5 py-2.5 text-[16px] leading-relaxed outline-none placeholder:text-faint focus:border-faint md:text-[14px]";
  return (
    <Layer>
      <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 backdrop-blur-[2px] md:items-center" onClick={close}>
        <div
          role="dialog"
          aria-modal="true"
          aria-label={heading}
          onClick={(e) => e.stopPropagation()}
          className="grid max-h-[92dvh] w-full max-w-xl gap-4 overflow-y-auto overscroll-contain rounded-t-[24px] border border-line bg-surface p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] shadow-2xl md:rounded-[24px] md:p-7"
        >
          <div className="flex items-start gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <h2 className="font-heading text-[20px] leading-snug">{heading}</h2>
              <p className="text-[12.5px] text-muted">It goes to {BIBLE_APPROVERS.toLowerCase()}. {kind === "add" ? "Approved, it joins the Bible's avatars." : "Approved, the old profile stays in the Bible, labeled retired with today's date."}</p>
            </div>
            <button type="button" onClick={close} aria-label="Close" className="-mr-2 grid h-11 w-11 shrink-0 place-items-center rounded-full text-lg text-faint hover:text-fg">
              ×
            </button>
          </div>
          {hint && <AvatarPerformance results={results} />}
          {kind !== "retire" && (
            <>
              <label className="grid gap-1.5">
                <span className="text-[12px] text-faint">Name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Weekend Host" className={field} />
              </label>
              <div className="grid gap-1.5">
                <span className="text-[12px] text-faint">How sure we are</span>
                <div role="radiogroup" className="flex rounded-full border border-line bg-bg p-0.5 text-[13px]">
                  {TIERS.map((t) => (
                    <button key={t} type="button" role="radio" aria-checked={tier === t} onClick={() => setTier(t)} className={`h-10 flex-1 rounded-full md:h-8 ${tier === t ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <label className="grid gap-1.5">
                <span className="text-[12px] text-faint">The profile: who they are, what they want, what stops them, what makes them act</span>
                <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={7} className={field} />
              </label>
            </>
          )}
          <label className="grid gap-1.5">
            <span className="text-[12px] text-faint">Why</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} placeholder={kind === "retire" ? "e.g. Three rounds on it, none hit the CPA target" : "e.g. Reviews keep naming this buyer"} className={field} />
          </label>
          <label className="grid gap-1.5">
            <span className="text-[12px] text-faint">Evidence (ad results, reviews, what the client said)</span>
            <textarea value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={3} className={field} />
          </label>
          {error && <p className="text-[13px] text-bad">{error}</p>}
          <button type="button" disabled={busy} onClick={send} className="h-12 rounded-full bg-brand px-5 text-[14px] font-medium text-white disabled:opacity-50 md:h-10 md:justify-self-end">
            {busy ? "Sending…" : "Send to the approvers"}
          </button>
        </div>
      </div>
    </Layer>
  );
}
