"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Flagged } from "@/lib/stepins/flagged";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { assignFlaggedAccount, commentOnFlagged } from "@/app/(team)/stepins/actions";

// "Flagged this week · N accounts", folded under the step-in deck: every account the line heads' Monday review
// flagged in this exec's lines, one row each (client, line, the hole, the person it's on, moving or stuck, the rung).
// A tap opens the row in place with the card's insides and its shared thread: a comment reaches the owner in the app
// and every exec sees it. Folded by default; open lives in the address (?flagged=1) so back folds it again.

const VIOLET = "#b892ff";
const RUNG: Record<Flagged["rung"], { t: string; c: string }> = { owner: { t: "With owner", c: "bg-ink/[0.07] text-ink/70" }, lead: { t: "With lead", c: "bg-warn-soft text-warn" }, stepin: { t: "Step-in", c: "bg-bad-soft text-bad" } };
type Person = { id: string; name: string };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export function FlaggedList({ rows, people }: { rows: Flagged[]; people: Person[] }) {
  const open = useParam("flagged") === "1";
  // A link to one row (?flagged=1#f-<id>) opens the list and scrolls to that row
  if (!rows.length) return null;
  const stuck = rows.filter((r) => r.status.kind === "stuck").length;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 border-t border-ink/[0.08] pt-4">
      <button type="button" aria-expanded={open} onClick={() => (open ? closeParams("flagged") : pushParams({ flagged: "1" }))} className="group flex min-h-11 items-center justify-between gap-3 text-left">
        <span className="grid gap-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em]" style={{ color: VIOLET }}>
            Flagged this week · {rows.length} account{rows.length === 1 ? "" : "s"}
          </span>
          <span className="text-[13px] text-ink/60">Everything the line heads&apos; Monday review flagged in your lines, and who it&apos;s on{stuck ? ` · ${stuck} stuck` : ""}</span>
        </span>
        <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border border-ink/10 text-ink/60 transition group-hover:text-fg ${open ? "rotate-90" : ""}`}>→</span>
      </button>
      {open && (
        <ul className="grid gap-1.5">
          {rows.map((r) => (
            <Row key={r.id} r={r} people={people} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ r, people }: { r: Flagged; people: Person[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const [pending, go] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [comment, setComment] = useState("");
  const [who, setWho] = useState("");
  const [due, setDue] = useState(r.dueOn ?? "");
  const [assigning, setAssigning] = useState(false);
  const run = (fn: () => Promise<{ ok: true; message?: string } | { ok: false; error: string }>, after?: () => void) =>
    go(async () => {
      const x = await fn();
      setMsg(x.ok ? { ok: true, text: x.message ?? "Saved." } : { ok: false, text: x.error });
      if (x.ok) {
        after?.();
        router.refresh();
      }
    });
  const status = r.status.kind === "stuck" ? `Stuck ${r.status.days}d` : r.status.kind === "handled" ? "Handled" : "Moving";
  return (
    <li id={`f-${r.id}`} className={`scroll-mt-24 overflow-hidden rounded-[16px] border bg-surface ${r.stepin ? "border-bad/40" : "border-line"}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="grid w-full gap-1 px-3.5 py-3 text-left md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.6fr)_minmax(0,1.2fr)_auto] md:items-center md:gap-3">
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-medium">{r.client}</span>
          <span className="text-[11.5px] text-muted">{r.lineLabel}</span>
        </span>
        <span className="truncate text-[13px] text-fg/90">{r.holes.slice(0, 2).join(" · ")}</span>
        <span className="truncate text-[12.5px] text-muted">{r.owner ? `On ${r.owner.label}` : "Nobody seated"}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <span className={`rounded-full px-2 py-0.5 text-[10.5px] ${r.status.kind === "stuck" ? "bg-bad-soft text-bad" : r.status.kind === "handled" ? "bg-ok-soft text-ok" : "bg-ink/[0.07] text-ink/70"}`}>{status}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10.5px] ${RUNG[r.rung].c}`}>{RUNG[r.rung].t}</span>
          {r.comments.length > 0 && <span className="text-[11px] text-muted">💬 {r.comments.length}</span>}
        </span>
      </button>
      {open && (
        <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 break-words border-t border-line px-3.5 py-3.5 text-[13px]">
          {r.holes.length > 2 && <p className="text-muted">Also: {r.holes.slice(2).join(" · ")}</p>}
          {r.results.length > 0 && (
            <div className="grid content-start gap-1">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">Numbers vs target</p>
              {r.results.map((x, i) => (
                <p key={i}>
                  · {x.text} <span className="text-[11px] text-faint">({x.confidence})</span>
                </p>
              ))}
            </div>
          )}
          <div className="grid items-start gap-3 md:grid-cols-2">
            <div className="grid content-start gap-1">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">The team did</p>
              {r.done.length ? r.done.map((d, i) => <p key={i}>· {d}</p>) : <p className="text-muted">Nothing on record this week</p>}
            </div>
            <div className="grid content-start gap-1">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">Hasn&apos;t done</p>
              {r.notDone.length ? r.notDone.map((d, i) => <p key={i}>· {d}</p>) : <p className="text-muted">No open promises</p>}
            </div>
          </div>
          {r.items.length > 0 && (
            <div className="grid content-start gap-1">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-faint">Stuck with the lead</p>
              {r.items.map((x, i) => (
                <p key={i}>
                  · {x.owner ? `${x.owner}: ` : ""}
                  {x.text}
                  {x.since ? <span className="text-faint"> · since {day(x.since)}</span> : null}
                </p>
              ))}
            </div>
          )}
          {r.dueOn && <p className="text-muted">Due {day(`${r.dueOn}T12:00:00Z`)}</p>}
          {r.comments.length > 0 && (
            <ul className="grid gap-2 border-t border-line pt-2">
              {r.comments.slice(-6).map((m) => (
                <li key={m.id}>
                  <span className="font-medium">{m.author ?? "Kaizen OS"}</span> <span className="text-faint">· {day(m.at)}</span>
                  <p>{m.body}</p>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder={r.owner ? `To ${r.owner.label}…` : "Comment…"} className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-bg px-4 text-[13.5px] text-fg outline-none focus:border-faint md:min-h-9" />
            <button type="button" disabled={pending || !comment.trim()} onClick={() => run(() => commentOnFlagged(r.id, comment), () => setComment(""))} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-40 md:min-h-9">
              Send
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setAssigning((v) => !v)} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] hover:border-faint md:min-h-8">
              Reassign · due date
            </button>
            <Link href={`/clients/${r.slug}`} className="inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] hover:border-faint md:min-h-8">
              Client page
            </Link>
          </div>
          {assigning && (
            <div className="flex flex-wrap gap-2">
              <select value={who} onChange={(e) => setWho(e.target.value)} className="min-h-11 min-w-0 max-w-full flex-1 rounded-full border border-line bg-bg px-3 text-[13px] text-fg md:min-h-9">
                <option value="">Keep on {r.owner?.label ?? "nobody"}</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className="min-h-11 rounded-full border border-line bg-bg px-3 text-[13px] text-fg md:min-h-9" />
              <button type="button" disabled={pending || (!who && due === (r.dueOn ?? ""))} onClick={() => run(() => assignFlaggedAccount(r.id, who || null, due || null), () => setAssigning(false))} className="inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-40 md:min-h-9">
                Save
              </button>
            </div>
          )}
          {msg && <p className={`text-[12px] ${msg.ok ? "text-muted" : "text-bad"}`}>{msg.text}</p>}
        </div>
      )}
    </li>
  );
}
