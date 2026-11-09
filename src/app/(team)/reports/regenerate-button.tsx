"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { toast } from "@/components/toasts";
import { clockTime } from "@/lib/reports/format";
import { regenerate, regenerateMany, regenProgress, undoRegenerate } from "./actions";

// Regenerate: an unsent report written again from scratch with the account's freshest numbers and the latest report
// logic. Asked once (the draft's edits are replaced; the old draft can be undone for a day), then it starts at once:
// the card shows it writing, and a toast says when it's done, even after leaving the page and coming back.

const KEY = "kz-regen";
type Batch = { ids: string[]; label: string; href: string | null; at: number };

const readBatches = (): Batch[] => {
  try {
    const list = JSON.parse(window.localStorage.getItem(KEY) ?? "[]") as Batch[];
    return Array.isArray(list) ? list.filter((b) => Date.now() - b.at < 3 * 3_600_000) : [];
  } catch {
    return [];
  }
};
const writeBatches = (list: Batch[]) => {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private windows: the toast just won't follow a reload
  }
};

/** Follows a batch of regenerated reports until every one is written (the Reports page shows a toast then). */
export function watchRegen(batch: Omit<Batch, "at">) {
  writeBatches([...readBatches(), { ...batch, at: Date.now() }]);
  window.dispatchEvent(new Event(KEY));
}

/** On the Reports page: refreshes the cards while regenerated reports are being written, and says when they're done. */
export function RegenWatcher() {
  const router = useRouter();
  const [tick, setTick] = useState(0);
  const last = useRef("");
  useEffect(() => {
    const kick = () => setTick((n) => n + 1);
    window.addEventListener(KEY, kick);
    return () => window.removeEventListener(KEY, kick);
  }, []);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      const batches = readBatches();
      if (!batches.length) return writeBatches([]);
      const rows = await regenProgress([...new Set(batches.flatMap((b) => b.ids))]).catch(() => null);
      if (!live) return;
      if (rows) {
        const status = new Map(rows.map((r) => [r.id, r.status]));
        const seen = rows.map((r) => `${r.id}:${r.status}`).join(",");
        if (seen !== last.current) {
          if (last.current) router.refresh();
          last.current = seen;
        }
        const writing = (id: string) => ["queued", "drafting"].includes(status.get(id) ?? "");
        const keep: Batch[] = [];
        for (const b of readBatches()) {
          if (b.ids.some(writing)) {
            keep.push(b);
            continue;
          }
          const failed = b.ids.filter((id) => status.get(id) === "failed").length;
          toast({
            tone: failed ? "warn" : "ok",
            title: `${b.label} regenerated`,
            body: failed ? `${failed} couldn't be written; open ${failed === 1 ? "it" : "them"} to try again.` : "Fresh numbers, written again and checked by the QA.",
            actions: b.href ? [{ label: "Open it", href: b.href, primary: true }] : undefined,
            ms: 8000,
          });
        }
        writeBatches(keep);
        if (!keep.length) return;
      }
      timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [tick, router]);
  return null;
}

function Spin({ on, size = 15 }: { on?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={on ? "animate-spin" : undefined}>
      <path d="M20 11a8 8 0 0 0-14.6-4.5M4 4v4h4M4 13a8 8 0 0 0 14.6 4.5M20 20v-4h-4" />
    </svg>
  );
}

/** The question, under the button: what regenerating replaces, and the go-ahead. */
function Confirm({ body, label, onGo, cancel }: { body: string; label: string; onGo: () => void; cancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Outside the button and its question (the button itself toggles it)
    const away = (e: PointerEvent) => !ref.current?.parentElement?.contains(e.target as Node) && cancel();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [cancel]);
  return (
    <div ref={ref} role="dialog" aria-label="Regenerate" className="absolute right-0 top-full z-30 mt-2 grid w-[min(300px,calc(100vw-32px))] animate-[step-in_.18s_ease] gap-3 rounded-[16px] border border-line bg-surface p-4 text-left shadow-[0_24px_60px_-20px_rgba(0,0,0,0.75)]">
      <p className="text-sm leading-snug text-fg">{body}</p>
      <div className="flex justify-end gap-1.5">
        <button type="button" onClick={cancel} className="h-11 rounded-full px-3.5 text-sm text-muted hover:text-fg md:h-9">
          Cancel
        </button>
        <button type="button" onClick={onGo} className="h-11 rounded-full bg-fg px-4 text-sm font-medium text-bg md:h-9">
          {label}
        </button>
      </div>
    </div>
  );
}

type Props =
  | { kind: "one"; id: string; label: string; variant: "icon" | "header"; sent?: boolean; approved?: boolean }
  | { kind: "many"; ids: string[]; label: string; variant: "icon" | "bulk"; approvedToo?: boolean; body?: string; sent?: boolean };

/**
 * Regenerate, as a card's small icon, the report studio's header button, or a section's "Regenerate all". Sent reports
 * show the button switched off, with why on hover.
 */
export function RegenerateButton(props: Props) {
  const router = useRouter();
  const [ask, setAsk] = useState(false);
  const [started, setStarted] = useState(false);
  const [, start] = useTransition();
  const close = useCallback(() => setAsk(false), []);
  const n = props.kind === "many" ? props.ids.length : 1;
  const why = "Already sent to the client, so it can't be regenerated";

  if (props.sent)
    return props.variant === "header" ? (
      <span title={why} className="inline-flex h-11 cursor-not-allowed items-center gap-2 rounded-full border border-line px-4 text-sm text-faint md:h-9">
        <Spin />
        Regenerate
      </span>
    ) : (
      <span title={why} aria-label={why} className="grid h-9 w-9 shrink-0 cursor-not-allowed place-items-center rounded-full bg-surface text-faint/60 max-md:hidden">
        <Spin />
      </span>
    );

  const body =
    props.kind === "many"
      ? (props.body ?? `Regenerate ${n} report${n === 1 ? "" : "s"} with fresh data? Edits on ${n === 1 ? "this draft" : "these drafts"} will be replaced. Approved and sent ones are kept, and they write a couple at a time in the background.`)
      : `Regenerate with fresh data? Your edits on this draft will be replaced${props.approved ? ", and it goes back to review" : ""}. You can undo it for 24 hours.`;

  const go = () => {
    setAsk(false);
    setStarted(true);
    start(async () => {
      const r = props.kind === "one" ? await regenerate(props.id) : await regenerateMany(props.ids, props.approvedToo);
      if (!r.ok) {
        setStarted(false);
        toast({ tone: "bad", title: "Couldn't regenerate", body: r.error });
        return;
      }
      const ids: string[] = props.kind === "one" ? [props.id] : "ids" in r ? (r.ids as string[]) : props.ids;
      if (props.variant !== "header") watchRegen({ ids, label: props.label, href: props.kind === "one" ? `/reports/${props.id}` : null });
      if (props.kind === "many" && ids.length < props.ids.length) toast({ tone: "info", title: `Regenerating ${ids.length} of ${props.ids.length}`, body: "The rest were already sent, approved or being written." });
      router.refresh();
      setStarted(false);
    });
  };

  const wrap = (button: React.ReactNode) => (
    <span className="relative inline-flex">
      {button}
      {ask && <Confirm body={body} label={n > 1 ? `Regenerate ${n}` : "Regenerate"} onGo={go} cancel={close} />}
    </span>
  );

  if (props.variant === "bulk")
    return wrap(
      <button type="button" disabled={started} onClick={() => setAsk((a) => !a)} aria-expanded={ask} className="inline-flex h-11 items-center gap-2 rounded-full border border-line px-3.5 text-xs text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-60 md:h-8">
        <Spin on={started} size={13} />
        {started ? "Starting…" : `Regenerate all ${n}`}
      </button>,
    );
  if (props.variant === "header")
    return wrap(
      <button type="button" disabled={started} onClick={() => setAsk((a) => !a)} aria-expanded={ask} className="inline-flex h-11 items-center gap-2 rounded-full border border-line px-4 text-sm text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-60 md:h-9">
        <Spin on={started} />
        {started ? "Regenerating…" : "Regenerate"}
      </button>,
    );
  return wrap(
    <button
      type="button"
      disabled={started}
      onClick={() => setAsk((a) => !a)}
      aria-expanded={ask}
      aria-label={`Regenerate ${props.label}`}
      title="Regenerate with fresh data"
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface text-faint transition-colors hover:bg-surface-2 hover:text-fg max-md:h-11 max-md:w-11 ${ask || started ? "text-fg" : ""}`}
    >
      <Spin on={started} />
    </button>,
  );
}

/** Under a regenerated report: when it was regenerated, and the way back to the draft it replaced (for a day). */
export function UndoRegenerate({ id, at, by }: { id: string; at: string; by: string | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [gone, setGone] = useState(false);
  if (gone) return null;
  const when = clockTime(at, true);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-line bg-surface px-4 py-2.5 text-sm">
      <span className="flex items-center gap-2 text-muted">
        <Spin size={13} />
        Regenerated with fresh data {when}
        {by ? ` by ${by}` : ""}.
      </span>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setGone(true);
            const r = await undoRegenerate(id);
            if (!r.ok) {
              setGone(false);
              toast({ tone: "bad", title: "Couldn't undo it", body: r.error });
              return;
            }
            toast({ tone: "ok", title: "Back to the earlier draft" });
            router.refresh();
          })
        }
        className="inline-flex h-11 items-center rounded-full px-3 text-sm text-fg underline-offset-4 hover:underline disabled:opacity-60 md:h-8"
      >
        Undo regenerate
      </button>
    </div>
  );
}
