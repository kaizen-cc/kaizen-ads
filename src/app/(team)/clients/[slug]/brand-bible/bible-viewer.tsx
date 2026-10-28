"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { Markdown } from "@/components/markdown";
import { audiencesOf, kindOf, quotesOf, splitBible, statsOf, type BibleSection, type Quote } from "@/lib/bible-sections";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import { clarifyBrandBible, clearBibleChat, markBrandBibleReviewed, type BibleTurn } from "../brand-bible-actions";
import { Layer } from "../layer";

// The Brand Bible, laid out to be read: a cover with what's in it, a contents rail that follows you down the page,
// each section in its own card (audience profiles as cards, the review bank as quotes, open questions you can answer),
// a PDF of the whole thing, and the review chat, where the strategist asks the open questions and every answer edits
// the Bible. The section you jump to and the open chat live in the address (?s=, ?ask=1), so back and forward work.

type Bible = {
  status: string;
  version: string;
  markdown: string;
  readThisFirst: string;
  teamNotes: string[];
  openQuestions: { question: string; who: string }[];
  generatedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  learnings: { at: string; kind: string; text: string }[];
  chat: BibleTurn[];
};

const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
const pad = (n: string) => (/^\d$/.test(n) ? `0${n}` : n);
const keyOf = (s: string) =>
  s
    .replace(/^#+\s*/, "")
    .replace(/^\d+[a-z]?[.)]?\s+/i, "")
    .trim()
    .toLowerCase();

const TIER: Record<string, string> = {
  proven: "bg-ok-soft text-ok",
  likely: "border border-line bg-surface-2 text-fg",
  hypothesis: "bg-warn-soft text-warn",
};

function Tier({ tier }: { tier: string | null }) {
  if (!tier) return null;
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] capitalize ${TIER[tier.toLowerCase()] ?? TIER.likely}`}>{tier.toLowerCase()}</span>;
}

/** Bigger, easier reading than the compact Markdown defaults */
function Prose({ text }: { text: string }) {
  return (
    <div className="max-w-[78ch] [&_li]:text-[14.5px] [&_li]:leading-[1.7] [&_p]:text-[14.5px] [&_p]:leading-[1.7] [&_table]:text-[12.5px]">
      <Markdown text={text} />
    </div>
  );
}

// ─── Read this first ──────────────────────────────────────────────────────────

type Block = { label: string; text: string; list: string[] };

/** The plain-text "Read this first" as labeled blocks ("Voice: …", "Rules that get creative rejected:" + its lines) */
function blocksOf(text: string): Block[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const blocks: Block[] = [];
  for (const line of lines) {
    if (!line || /read this first/i.test(line)) continue;
    const last = blocks[blocks.length - 1];
    // A line under a label that has nothing after its colon (or already has lines) is one of its items
    if (last && last.label && (!last.text || last.list.length) && !/^[A-Z][A-Za-z ,&/'()-]{1,48}:\s/.test(line)) {
      last.list.push(line.replace(/^(?:\d+[.)]|[-*•])\s+/, ""));
      continue;
    }
    // A line can carry more than one label: "Voice: … . Look: …"
    for (const part of line.split(/(?<=[.)”"])\s+(?=[A-Z][A-Za-z ,&/'-]{1,32}:\s)/)) {
      const m = part.match(/^([A-Z][A-Za-z ,&/'()-]{1,48}):\s*(.*)$/);
      if (m) blocks.push({ label: m[1], text: m[2], list: [] });
      else if (blocks.length) blocks[blocks.length - 1].text += ` ${part}`;
      else blocks.push({ label: "", text: part, list: [] });
    }
  }
  return blocks;
}

function Item({ text, n }: { text: string; n: number }) {
  const letter = text.match(/^([A-H])\.\s+(.*?)(?:\s*\((Proven|Likely|Hypothesis)\))?\s*$/);
  if (letter)
    return (
      <li className="flex items-start gap-3 text-[14.5px] leading-relaxed md:col-span-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-surface-2 font-heading text-[12px]">{letter[1]}</span>
        <span className="min-w-0 flex-1 pt-0.5">{letter[2]}</span>
        <Tier tier={letter[3] ?? null} />
      </li>
    );
  const quote = text.match(/^[“"](.+?)[”"]\s*(.*)$/);
  if (quote)
    return (
      <li className="grid gap-1 rounded-[14px] border border-line bg-surface/60 px-4 py-3">
        <span className="font-heading text-[14.5px] leading-relaxed">“{quote[1]}”</span>
        {quote[2] && <span className="text-[12px] text-faint">{quote[2]}</span>}
      </li>
    );
  return (
    <li className="flex gap-3 text-[14px] leading-relaxed">
      <span className="tabular w-5 shrink-0 pt-px text-right font-heading text-[13px] text-brand-text">{n}</span>
      <span className="min-w-0">{text}</span>
    </li>
  );
}

function ReadThisFirst({ text }: { text: string }) {
  const blocks = blocksOf(text);
  if (!blocks.length) return <Prose text={text} />;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {blocks.map((b, i) => {
        // "A. Fresh-Fish Seeker: … (Likely) B. …" on one line reads better as a list
        const lettered = b.text.split(/\s(?=[A-H]\.\s)/).map((x) => x.trim()).filter(Boolean);
        const items = b.list.length ? b.list : lettered.length > 1 ? lettered : [];
        const intro = items === lettered ? "" : b.text.trim();
        const wide = items.length > 0 || b.text.length > 260 || i === 0;
        return (
          <div key={i} className={`min-w-0 rounded-[18px] border border-line bg-bg/60 p-4 md:p-5 ${wide ? "md:col-span-2" : ""}`}>
            {b.label && <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">{b.label}</p>}
            {intro && <p className={`leading-relaxed ${i === 0 ? "text-[16px] md:text-[18px]" : "text-[14.5px] text-muted"}`}>{intro}</p>}
            {items.length > 0 && (
              <ol className={`grid gap-x-6 gap-y-2.5 md:grid-cols-2 ${intro ? "mt-3" : ""}`}>
                {items.map((l, k) => (
                  <Item key={k} text={l} n={k + 1} />
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function AudienceCard({ title, tier, body }: { title: string; tier: string | null; body: string }) {
  const [open, setOpen] = useState(false);
  const m = title.match(/^([A-Z])\s*[·.:-]\s*(.*)$/);
  return (
    <article className="relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-[20px] border border-line bg-bg/60 p-5">
      <header className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[14px] bg-brand-soft font-display text-[18px] text-brand-text">{m?.[1] ?? "•"}</span>
        <h3 className="min-w-0 flex-1 pt-1 font-heading text-[17px] leading-snug">{m?.[2] ?? title}</h3>
        <Tier tier={tier} />
      </header>
      <div className={`relative ${open ? "" : "max-h-[230px] overflow-hidden"}`}>
        <Markdown text={body} />
        {!open && <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-bg to-transparent" />}
      </div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="h-11 self-start rounded-full px-1 text-[13px] text-muted hover:text-fg md:h-8">
        {open ? "Show less" : "Read the full profile →"}
      </button>
    </article>
  );
}

const USE = {
  ok: { label: "Cleared for ads", cls: "bg-ok-soft text-ok" },
  check: { label: "Needs sign-off", cls: "bg-warn-soft text-warn" },
  no: { label: "Not for ads", cls: "bg-bad-soft text-bad" },
} as const;

function QuoteCard({ q }: { q: Quote }) {
  return (
    <figure className="flex min-w-0 flex-col gap-3 rounded-[20px] border border-line bg-bg/60 p-5">
      <span aria-hidden className="font-display text-[40px] leading-[0.6] text-brand-text">“</span>
      <blockquote className="font-heading text-[16px] leading-relaxed">{q.quote}</blockquote>
      <figcaption className="mt-auto grid gap-2 pt-2">
        <span className="text-[13px] text-fg">{q.who || "Customer"}</span>
        {q.meta && <span className="text-[12px] leading-relaxed text-faint">{q.meta.replace(/\*\*/g, "")}</span>}
        {q.use && (
          <span className={`w-fit rounded-full px-2.5 py-0.5 text-[11px] ${USE[q.use].cls}`} title={q.useNote}>
            {USE[q.use].label}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

const withoutTables = (body: string) =>
  body
    .split("\n")
    .filter((l) => !l.trim().startsWith("|"))
    .join("\n");

function SectionBody({ sec, onAnswer, questions, canEdit }: { sec: BibleSection; onAnswer: (q: string) => void; questions: Bible["openQuestions"]; canEdit: boolean }) {
  const kind = kindOf(sec.title);
  if (kind === "audiences") {
    const { intro, list } = audiencesOf(sec.body);
    return (
      <div className="grid gap-6">
        {intro && <Prose text={intro} />}
        {list.length > 0 && (
          <div className="grid gap-3 lg:grid-cols-2">
            {list.map((a) => (
              <AudienceCard key={a.title} {...a} />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (kind === "reviews") {
    const quotes = quotesOf(sec.body);
    if (!quotes.length) return <Prose text={sec.body} />;
    const notes = withoutTables(sec.body).trim();
    return (
      <div className="grid gap-6">
        {notes && <Prose text={notes} />}
        <div className="grid gap-3 md:grid-cols-2">
          {quotes.map((q, i) => (
            <QuoteCard key={i} q={q} />
          ))}
        </div>
      </div>
    );
  }
  if (kind === "questions") {
    if (!questions.length) return <p className="rounded-[18px] border border-ok/30 bg-ok-soft px-4 py-3 text-[14px] text-ok">Nothing open. The Bible is ready for review.</p>;
    return (
      <ol className="grid gap-3">
        {questions.map((q, i) => (
          <li key={i} className="flex flex-wrap items-start gap-3 rounded-[18px] border border-line bg-bg/60 p-4 md:flex-nowrap md:p-5">
            <span className="tabular grid h-8 w-8 shrink-0 place-items-center rounded-full bg-warn-soft font-heading text-[13px] text-warn">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[14.5px] leading-relaxed">{q.question}</p>
              <p className="mt-1 text-[12px] text-faint">Answered by: {q.who}</p>
            </div>
            {canEdit && (
              <button type="button" onClick={() => onAnswer(q.question)} className="h-11 w-full shrink-0 rounded-full border border-line px-4 text-[13px] text-muted hover:border-faint hover:text-fg md:h-9 md:w-auto">
                Answer
              </button>
            )}
          </li>
        ))}
      </ol>
    );
  }
  return <Prose text={sec.body} />;
}

// ─── The review chat ──────────────────────────────────────────────────────────

function BibleChat({
  clientId,
  slug,
  initial,
  seed,
  questions,
  canEdit,
  onClose,
  onJump,
}: {
  clientId: string;
  slug: string;
  initial: BibleTurn[];
  seed: string;
  questions: Bible["openQuestions"];
  canEdit: boolean;
  onClose: () => void;
  onJump: (key: string) => void;
}) {
  const router = useRouter();
  const [turns, setTurns] = useState(initial);
  const [text, setText] = useState(seed);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length, busy]);
  useEffect(() => {
    if (seed) box.current?.focus();
  }, [seed]);

  const send = (msg = text) => {
    if (!msg.trim() || busy) return;
    const now = new Date().toISOString();
    setTurns((t) => [...t, { role: "user", text: msg.trim(), at: now }]);
    setText("");
    setError(null);
    start(async () => {
      const r = await clarifyBrandBible(clientId, slug, msg);
      if (r.ok) {
        setTurns(r.chat);
        router.refresh();
      } else {
        setError(r.error);
        setTurns((t) => t.slice(0, -1));
        setText(msg);
      }
    });
  };

  const opener = questions.length
    ? `I have ${questions.length} open question${questions.length === 1 ? "" : "s"} on this Bible. Answer any of them here and I'll update the Bible as we go. The first: ${questions[0].question}`
    : "Nothing's open. Tell me anything to correct or add and I'll update the Bible.";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-3 border-b border-line px-5 py-4">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-text" aria-hidden>
          ✦
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-heading text-[15px]">Clarify with the strategist</p>
          <p className="text-[12px] text-faint">Answers update the Bible directly.</p>
        </div>
        {turns.length > 0 && canEdit && (
          <button
            type="button"
            onClick={() =>
              start(async () => {
                await clearBibleChat(clientId, slug);
                setTurns([]);
              })
            }
            className="h-11 rounded-full px-2.5 text-[12px] text-faint hover:text-fg md:h-8"
          >
            Start over
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-full text-muted hover:bg-surface-2 hover:text-fg md:h-8 md:w-8">
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="grid gap-4">
          <p className="max-w-[92%] rounded-[16px] border border-line bg-surface-2/60 px-4 py-3 text-[13.5px] leading-relaxed">{opener}</p>
          {turns.map((t, i) => (
            <div key={i} className={`grid gap-1.5 ${t.role === "user" ? "justify-items-end" : ""}`}>
              <p className={`max-w-[92%] whitespace-pre-wrap rounded-[16px] px-4 py-3 text-[13.5px] leading-relaxed ${t.role === "user" ? "bg-fg text-bg" : "border border-line bg-surface-2/60"}`}>{t.text}</p>
              {t.role === "assistant" && ((t.changed?.length ?? 0) > 0 || (t.resolved?.length ?? 0) > 0) && (
                <div className="flex max-w-[92%] flex-wrap gap-1.5">
                  {t.changed?.map((c) => (
                    <button key={c} type="button" onClick={() => onJump(c)} className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-ok/30 bg-ok-soft px-3 text-[11.5px] capitalize text-ok md:min-h-7">
                      ✓ Updated: {c}
                    </button>
                  ))}
                  {t.resolved?.map((q) => (
                    <span key={q} className="inline-flex min-h-9 max-w-full items-center truncate rounded-full border border-line px-3 text-[11.5px] text-muted md:min-h-7" title={q}>
                      Settled: {q.length > 48 ? `${q.slice(0, 48)}…` : q}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="grid max-w-[70%] gap-2 rounded-[16px] border border-line bg-surface-2/60 px-4 py-3">
              <span className="text-[12.5px] text-muted">Updating the Bible…</span>
              <span className="h-1 overflow-hidden rounded-full bg-surface-2">
                <span className="block h-full w-1/3 animate-[ai-sweep_2.4s_ease-in-out_infinite] rounded-full bg-brand" />
              </span>
            </div>
          )}
          <div ref={end} />
        </div>
      </div>

      {canEdit ? (
        <div className="grid gap-2 border-t border-line p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {questions.length > 0 && !text && (
            <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
              {questions.slice(0, 6).map((q, i) => (
                <button key={i} type="button" onClick={() => setText(`About "${q.question.slice(0, 90)}${q.question.length > 90 ? "…" : ""}": `)} className="min-h-9 shrink-0 rounded-full border border-line px-3 text-[12px] text-muted hover:text-fg md:min-h-7">
                  Q{i + 1}: {q.question.length > 34 ? `${q.question.slice(0, 34)}…` : q.question}
                </button>
              ))}
            </div>
          )}
          {error && <p className="px-1 text-[12px] text-bad">{error}</p>}
          <div className="flex items-end gap-2 rounded-[18px] border border-line bg-bg px-3 py-2 focus-within:border-faint">
            <textarea
              ref={box}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={2}
              placeholder="Answer a question, or correct anything in the Bible…"
              className="max-h-40 min-h-11 flex-1 resize-none bg-transparent py-1.5 text-[16px] leading-relaxed outline-none placeholder:text-faint md:text-[13.5px]"
            />
            <button type="button" disabled={busy || !text.trim()} onClick={() => send()} className="h-11 shrink-0 rounded-full bg-brand px-4 text-[13px] font-medium text-white disabled:opacity-40 md:h-9">
              Send
            </button>
          </div>
        </div>
      ) : (
        <p className="border-t border-line px-5 py-4 text-[12.5px] text-faint">Execs and leads answer the Bible&apos;s questions here.</p>
      )}
    </div>
  );
}

// ─── The page ─────────────────────────────────────────────────────────────────

// Wide screens dock the chat beside the Bible; smaller ones open it as a sheet (one chat, never both)
const WIDE = "(min-width: 1280px)";
const onWide = (cb: () => void) => {
  const m = window.matchMedia(WIDE);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const useWide = () => useSyncExternalStore(onWide, () => window.matchMedia(WIDE).matches, () => true);

export function BibleViewer({ client, bible, canEdit }: { client: { id: string; name: string; slug: string }; bible: Bible; canEdit: boolean }) {
  const router = useRouter();
  const sections = splitBible(bible.markdown);
  const stats = statsOf(sections);
  const target = useParam("s");
  const asking = useParam("ask") === "1";
  const wide = useWide();
  const [active, setActive] = useState<string | null>(null);
  const [seed, setSeed] = useState({ n: 0, text: "" });
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Jumping to a section (from the contents, or back and forward through the ones visited)
  useEffect(() => {
    if (target) document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [target]);

  // The contents follow the section on screen
  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => Boolean(e));
    const seen = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-20% 0px -65% 0px" },
    );
    els.forEach((e) => seen.observe(e));
    return () => seen.disconnect();
  }, [bible.markdown]); // eslint-disable-line react-hooks/exhaustive-deps

  const jump = (id: string) => pushParams({ s: id });
  const jumpKey = (key: string) => {
    const s = sections.find((x) => keyOf(x.heading) === key || x.title.toLowerCase() === key);
    if (s) jump(s.id);
  };
  const openChat = (text = "") => {
    setSeed((s) => ({ n: s.n + 1, text }));
    pushParams({ ask: "1" });
  };
  const closeChat = () => closeParams("ask");
  const qSection = sections.find((s) => kindOf(s.title) === "questions");
  const whatTheySell = blocksOf(bible.readThisFirst).find((b) => /what they sell|the business|who they are/i.test(b.label))?.text;
  const reviewed = bible.status === "reviewed";

  const chat = (
    <BibleChat
      key={seed.n}
      clientId={client.id}
      slug={client.slug}
      initial={bible.chat}
      seed={seed.text}
      questions={bible.openQuestions}
      canEdit={canEdit}
      onClose={closeChat}
      onJump={(k) => {
        jumpKey(k);
        if (!wide) closeChat();
      }}
    />
  );

  const tiles: [string, number, string | undefined][] = [
    ["Audiences", stats.audiences, sections.find((s) => kindOf(s.title) === "audiences")?.id],
    ["Reviews in the bank", stats.reviews, sections.find((s) => kindOf(s.title) === "reviews")?.id],
    ["Competitors", stats.competitors, sections.find((s) => /competitor/i.test(s.title))?.id],
    ["Marketing moments", stats.moments, sections.find((s) => /calendar|moments/i.test(s.title))?.id],
  ];

  return (
    <div className="mx-auto grid w-full max-w-[1480px] gap-6 pb-24">
      {/* The bar: back to the client, status, PDF, the chat */}
      <div className="-mx-4 -mt-6 flex items-center gap-2 border-b border-line bg-bg/85 px-4 py-3 backdrop-blur-xl md:sticky md:top-0 md:z-30 md:-mx-10 md:-mt-8 md:px-10">
        <Link href={`/clients/${client.slug}`} className="inline-flex h-11 min-w-0 items-center gap-1.5 rounded-full pr-2 text-[13px] text-muted hover:text-fg md:h-9">
          <span aria-hidden>←</span> <span className="truncate">{client.name}</span>
        </Link>
        <span className="hidden text-faint md:inline">/</span>
        <span className="hidden font-heading text-[14px] md:inline">Brand Bible</span>
        <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] ${reviewed ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{reviewed ? "Reviewed" : "Draft"}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <a
            href={`/api/clients/${client.id}/brand-bible/pdf`}
            className="inline-flex h-11 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13px] text-muted hover:border-faint hover:text-fg md:h-9"
          >
            <span aria-hidden>↓</span> PDF
          </a>
          <button
            type="button"
            onClick={() => (asking ? closeChat() : openChat())}
            className={`relative inline-flex h-11 items-center gap-2 rounded-full px-4 text-[13px] md:h-9 ${asking ? "bg-surface-2 text-fg" : "bg-fg text-bg"}`}
          >
            <span aria-hidden>✦</span> Clarify
            {bible.openQuestions.length > 0 && <span className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1.5 text-[11px] font-medium text-white">{bible.openQuestions.length}</span>}
          </button>
        </div>
      </div>

      {/* Cover */}
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 py-7 md:px-10 md:py-10">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 -z-10 h-96 w-96 rounded-full bg-brand/25 blur-[120px]" />
        <span aria-hidden className="pointer-events-none absolute -bottom-40 left-1/4 -z-10 h-80 w-80 rounded-full bg-[#5b8def]/15 blur-[120px]" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-faint">
          Brand Bible · {bible.version}
          {bible.generatedAt && ` · ${fmt(bible.generatedAt)}`}
        </p>
        <h1 className="mt-3 font-display text-[40px] leading-[1.02] tracking-tight md:text-[64px]">{client.name}</h1>
        {whatTheySell && <p className="mt-4 max-w-[62ch] text-[15px] leading-relaxed text-muted md:text-[17px]">{whatTheySell}</p>}
        <dl className="mt-7 grid grid-cols-2 gap-3 md:grid-cols-5">
          {tiles.map(([label, n, id]) => (
            <button key={label} type="button" disabled={!id} onClick={() => id && jump(id)} className="grid gap-1 rounded-[18px] border border-line bg-bg/40 px-4 py-3 text-left transition-colors hover:border-faint disabled:hover:border-line">
              <dd className="tabular font-display text-[28px] leading-none">{n}</dd>
              <dt className="text-[11.5px] text-faint">{label}</dt>
            </button>
          ))}
          <button
            type="button"
            onClick={() => (qSection ? jump(qSection.id) : openChat())}
            className={`col-span-2 grid gap-1 rounded-[18px] border px-4 py-3 text-left md:col-span-1 ${bible.openQuestions.length ? "border-warn/40 bg-warn-soft/60" : "border-ok/30 bg-ok-soft/60"}`}
          >
            <dd className={`tabular font-display text-[28px] leading-none ${bible.openQuestions.length ? "text-warn" : "text-ok"}`}>{bible.openQuestions.length}</dd>
            <dt className="text-[11.5px] text-faint">{bible.openQuestions.length ? "Open questions" : "Nothing open"}</dt>
          </button>
        </dl>
        <div className="mt-6 flex flex-wrap items-center gap-3 text-[12.5px] text-faint">
          {reviewed ? (
            <span>
              Reviewed{bible.reviewedBy && ` by ${bible.reviewedBy}`}
              {bible.reviewedAt && ` on ${fmt(bible.reviewedAt)}`}. Every agent reads it.
            </span>
          ) : (
            <>
              <span>Draft: waiting for the Head of Creative. Agents read it as a draft until then.</span>
              {canEdit && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    start(async () => {
                      const r = await markBrandBibleReviewed(client.id, client.slug);
                      if (r.ok) router.refresh();
                      else setError(r.error);
                    })
                  }
                  className="h-11 rounded-full bg-ok px-4 text-[13px] font-medium text-white disabled:opacity-50 md:h-9"
                >
                  Mark reviewed
                </button>
              )}
            </>
          )}
          {error && <span className="text-bad">{error}</span>}
        </div>
      </section>

      {/* Contents on phones: a strip under the bar */}
      <nav aria-label="Sections" className="no-scrollbar sticky top-[calc(3.5rem+env(safe-area-inset-top))] z-20 -mx-4 flex gap-1.5 overflow-x-auto border-b border-line bg-bg/85 px-4 py-2 backdrop-blur-xl md:top-[68px] md:-mx-10 md:px-10 lg:hidden">
        {sections.map((s) => (
          <button key={s.id} type="button" onClick={() => jump(s.id)} className={`min-h-9 shrink-0 rounded-full px-3 text-[12.5px] ${active === s.id ? "bg-fg text-bg" : "text-muted"}`}>
            {s.title}
          </button>
        ))}
      </nav>

      <div className={`grid items-start gap-6 lg:grid-cols-[210px_minmax(0,1fr)] ${asking ? "xl:grid-cols-[210px_minmax(0,1fr)_400px]" : ""}`}>
        {/* Contents on wider screens: a rail that follows the page */}
        <nav aria-label="Sections" className="sticky top-20 hidden max-h-[calc(100dvh-6rem)] overflow-y-auto lg:block">
          <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Contents</p>
          <ul className="grid gap-0.5">
            {sections.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => jump(s.id)}
                  className={`flex w-full items-baseline gap-2.5 rounded-[10px] px-3 py-1.5 text-left text-[13px] transition-colors ${active === s.id ? "bg-surface-2 text-fg" : "text-muted hover:text-fg"}`}
                >
                  <span className="tabular w-6 shrink-0 font-heading text-[11px] text-faint">{s.num ? pad(s.num) : "·"}</span>
                  <span className="min-w-0">{s.title}</span>
                  {kindOf(s.title) === "questions" && bible.openQuestions.length > 0 && <span className="ml-auto h-1.5 w-1.5 shrink-0 self-center rounded-full bg-warn" />}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <main className="grid min-w-0 gap-5">
          {sections.map((s) => {
            const kind = kindOf(s.title);
            if (kind === "reference")
              return (
                <details key={s.id} id={s.id} className="group scroll-mt-32 rounded-[24px] border border-line bg-surface px-5 py-4 md:px-8">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3">
                    <span className="tabular font-heading text-[13px] text-faint">{s.num ? pad(s.num) : "·"}</span>
                    <span className="font-heading text-[18px]">{s.title}</span>
                    <span className="ml-auto text-[12px] text-faint group-open:hidden">Show</span>
                    <span className="ml-auto hidden text-[12px] text-faint group-open:inline">Hide</span>
                  </summary>
                  <div className="pt-4">
                    <Prose text={s.body} />
                  </div>
                </details>
              );
            return (
              <section
                key={s.id}
                id={s.id}
                className={`scroll-mt-32 rounded-[24px] border p-5 md:p-8 ${kind === "first" ? "relative isolate overflow-hidden border-brand/30 bg-surface" : "border-line bg-surface"}`}
              >
                {kind === "first" && <span aria-hidden className="pointer-events-none absolute -left-24 -top-24 -z-10 h-72 w-72 rounded-full bg-brand/10 blur-[100px]" />}
                <header className="mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="tabular font-heading text-[13px] text-brand-text">{kind === "first" ? "Start here" : s.num ? pad(s.num) : ""}</span>
                  <h2 className="font-heading text-[22px] leading-tight md:text-[26px]">{s.title}</h2>
                  {kind === "first" && <span className="w-full text-[12.5px] text-faint">What every brief, script and review starts from.</span>}
                </header>
                {kind === "first" ? (
                  <ReadThisFirst text={bible.readThisFirst || s.body} />
                ) : (
                  <SectionBody sec={s} questions={bible.openQuestions} canEdit={canEdit} onAnswer={(q) => openChat(`About "${q.slice(0, 120)}${q.length > 120 ? "…" : ""}": `)} />
                )}
              </section>
            );
          })}

          {bible.learnings.length > 0 && (
            <section className="rounded-[24px] border border-line bg-surface p-5 md:p-8">
              <h2 className="font-heading text-[22px]">What their ads proved since</h2>
              <p className="mt-1 text-[12.5px] text-faint">Kept current from the client playbook; newer than the Bible&apos;s text where they disagree.</p>
              <ul className="mt-5 grid gap-2.5">
                {[...bible.learnings].reverse().map((l, i) => (
                  <li key={i} className="flex gap-3 text-[14px] leading-relaxed">
                    <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${l.kind === "avoid" ? "bg-bad" : "bg-ok"}`} />
                    <span className="min-w-0">
                      {l.text} <span className="text-[11.5px] text-faint">{l.at}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {bible.teamNotes.length > 0 && (
            <details className="group rounded-[24px] border border-dashed border-line bg-surface/60 px-5 py-4 md:px-8">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3">
                <span className="font-heading text-[18px]">For the team</span>
                <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-faint">Internal · not in the client&apos;s copy</span>
                <span className="ml-auto text-[12px] text-faint">{bible.teamNotes.length} notes</span>
              </summary>
              <ul className="grid gap-2.5 pt-4">
                {bible.teamNotes.map((n, i) => (
                  <li key={i} className="flex gap-3 text-[13.5px] leading-relaxed text-muted">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-faint" />
                    <span className="min-w-0">{n}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </main>

        {/* The chat: docked beside the Bible on wide screens, a full sheet on smaller ones */}
        {asking && wide && <aside className="sticky top-20 h-[calc(100dvh-6rem)] overflow-hidden rounded-[24px] border border-line bg-surface">{chat}</aside>}
      </div>
      {asking && !wide && <SmallChat>{chat}</SmallChat>}
    </div>
  );
}

/** Below the wide breakpoint the chat is a sheet over the page */
function SmallChat({ children }: { children: React.ReactNode }) {
  return (
    <Layer>
      <div className="fixed inset-0 z-[60] flex justify-end bg-black/40 backdrop-blur-sm">
        <div className="flex h-full w-full flex-col bg-surface shadow-2xl md:max-w-[440px] md:border-l md:border-line">{children}</div>
      </div>
    </Layer>
  );
}
