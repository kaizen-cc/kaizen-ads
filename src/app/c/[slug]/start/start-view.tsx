"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PACING, STYLES, guideProgress, type Guide, type StyleStep } from "@/lib/onboarding-guide-types";
import { createClient } from "@/lib/supabase/client";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { HelpTurn } from "@/lib/setup-help";
import { askHelp, assetSlots, assetsShared, googleSend, helpSlots, helpToCall, metaDone, onTheCall, saveStyle } from "./actions";

// The client's setup, as a few short, visual steps: each opens full screen (in the address, so back closes it), walks
// them through with pictures of the screens they'll see, and says plainly when it's done. Nothing here is a form to
// puzzle over: copy buttons for every ID, one tap for "let's do it on our call".

type Props = { slug: string; brand: string; firstName: string | null; guide: Guide; has: { meta: boolean; google: boolean; looks: boolean }; bmId: string | null; adminEmails: string[]; managerId: string | null; examples: { id: string; image: string; video: boolean }[]; presentation: string | null; help: Record<"meta" | "google", HelpTurn[]> };
type StepKey = "meta" | "google" | "assets" | "style";

export function StartView(p: Props) {
  const step = useParam("step") as StepKey | null;
  const { done, total } = guideProgress(p.guide, p.has);
  const steps: { key: StepKey; title: string; line: string; mins: string; state: "done" | "call" | "todo" | "wait" }[] = [
    ...(p.has.meta ? [{ key: "meta" as const, title: "Facebook & Instagram access", line: "Add Kaizen as a partner so we can run your ads", mins: "4 min", state: (p.guide.meta.status === "verified" ? "done" : p.guide.meta.status === "on_call" ? "call" : p.guide.meta.status === "done" ? "wait" : "todo") as "done" | "call" | "todo" | "wait" }] : []),
    ...(p.has.google ? [{ key: "google" as const, title: "Google Ads", line: "Send us your account ID (or make one)", mins: "2 min", state: (p.guide.google.status === "verified" ? "done" : p.guide.google.status === "on_call" ? "call" : ["sent", "invited", "none"].includes(p.guide.google.status ?? "") ? "wait" : "todo") as "done" | "call" | "todo" | "wait" }] : []),
    { key: "assets", title: "Your brand assets", line: "Logo, photos, videos, brand guide", mins: "3 min", state: (p.guide.assets.files ?? 0) + (p.guide.assets.links ?? 0) ? "done" : "todo" },
    ...(p.has.looks ? [{ key: "style" as const, title: "The look you want", line: "Pick the styles and pacing you love", mins: "2 min", state: (p.guide.style.styles?.length || p.guide.style.pacing ? "done" : "todo") as "done" | "todo" }] : []),
  ];
  const pct = Math.round((done / Math.max(1, total)) * 100);

  return (
    <div className="grid gap-5">
      {/* Where they are */}
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 pb-7 pt-8 md:px-10 md:pb-10 md:pt-12">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 -z-10 h-96 w-96 rounded-full bg-brand/30 blur-[120px]" />
        <div className="flex items-center gap-5">
          <Ring pct={pct} />
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Kaizen Marketing · {p.brand}</p>
            <h1 className="mt-2 font-heading text-[28px] leading-[1.08] tracking-tight md:text-[42px]">{done === total ? "You're all set" : `${p.firstName ? `${p.firstName}, l` : "L"}et's get you set up`}</h1>
          </div>
        </div>
        <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-muted">{done === total ? "Everything's in. We're building your brand plan and your first ads now, and you'll hear from us as each is ready." : `${total - done} quick step${total - done === 1 ? "" : "s"} so we can start building. Each one walks you through it, screen by screen. Stuck on anything? Tap "Let's do it on our call" and we'll handle it together.`}</p>
      </section>

      <div className="grid gap-3">
        {steps.map((s, i) => (
          <button key={s.key} type="button" onClick={() => pushParams({ step: s.key })} className="group flex items-center gap-4 rounded-[20px] border border-line bg-surface p-4 text-left transition-colors hover:border-faint md:p-5">
            <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-[15px] font-semibold ${s.state === "done" ? "bg-ok text-white" : s.state === "call" ? "bg-warn-soft text-warn" : s.state === "wait" ? "bg-brand/15 text-brand-text" : "bg-surface-2 text-muted"}`}>
              {s.state === "done" ? "✓" : s.state === "call" ? "☎" : s.state === "wait" ? "…" : i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-heading text-[17px] leading-snug">{s.title}</span>
              <span className="block text-[13.5px] text-muted">{s.state === "done" ? "Done" : s.state === "call" ? "We'll do it together on our call" : s.state === "wait" ? "Checking on our side…" : s.line}</span>
            </span>
            <span className="shrink-0 text-[12px] text-faint group-hover:text-fg">{s.state === "todo" ? `${s.mins} →` : "→"}</span>
          </button>
        ))}
        {p.presentation && (
          <Link href={`/c/${p.slug}/plan`} className="flex items-center gap-4 rounded-[20px] border border-brand/40 bg-brand/[0.06] p-4 md:p-5">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand text-white">✦</span>
            <span className="min-w-0 flex-1">
              <span className="block font-heading text-[17px]">How we see you</span>
              <span className="block text-[13.5px] text-muted">{p.presentation === "approved" ? "Approved, thank you" : "Your brand plan is ready: tell us if we got it right"}</span>
            </span>
            <span className="text-[12px] text-brand-text">Open →</span>
          </Link>
        )}
      </div>

      {step === "meta" && p.has.meta && <MetaSheet {...p} />}
      {step === "google" && p.has.google && <GoogleSheet {...p} />}
      {step === "assets" && <AssetsSheet {...p} />}
      {step === "style" && p.has.looks && <StyleSheet {...p} />}
    </div>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <span className="relative grid h-16 w-16 shrink-0 place-items-center md:h-20 md:w-20">
      <svg viewBox="0 0 64 64" className="absolute inset-0 -rotate-90">
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="5" className="text-line" />
        <circle cx="32" cy="32" r={r} fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" className="text-brand transition-[stroke-dashoffset] duration-700" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} />
      </svg>
      <span className="tabular font-heading text-[15px]">{pct}%</span>
    </span>
  );
}

/** Full screen on a phone, a big panel on a computer */
function Sheet({ title, kicker, children, help }: { title: string; kicker: string; children: React.ReactNode; /** The help chat: beside the steps on a computer, a button away on a phone */ help?: React.ReactNode }) {
  const helpOpen = useParam("help") === "1";
  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close" onClick={() => closeParams("step", "help")} className="absolute inset-0 bg-black/50 backdrop-blur-[2px] max-md:hidden" />
      <div className={`relative flex h-full w-full flex-col overflow-hidden border-l border-line bg-bg ${help ? "md:w-[min(720px,94vw)] lg:w-[min(1180px,96vw)]" : "md:w-[min(720px,94vw)]"}`}>
        <header className="pt-safe flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-faint">{kicker}</p>
            <p className="truncate font-heading text-[17px]">{title}</p>
          </div>
          <button type="button" onClick={() => closeParams("step", "help")} className="grid h-11 w-11 place-items-center rounded-full text-[20px] text-muted hover:text-fg" aria-label="Close">
            ×
          </button>
        </header>
        <div className={`min-h-0 flex-1 ${help ? "lg:grid lg:grid-cols-[minmax(0,1fr)_420px]" : ""}`}>
          <div className={`h-full overflow-y-auto px-4 py-5 md:px-6 ${help ? "pb-28 lg:pb-8" : "pb-[calc(1.5rem+env(safe-area-inset-bottom))]"}`}>{children}</div>
          {help && <aside className="hidden h-full min-h-0 flex-col border-l border-line bg-surface lg:flex">{help}</aside>}
        </div>
        {help && !helpOpen && (
          <button type="button" onClick={() => pushParams({ help: "1" })} className="absolute bottom-[calc(1rem+env(safe-area-inset-bottom))] left-4 right-4 flex h-14 items-center gap-3 rounded-full bg-brand pl-2 pr-5 text-left text-white shadow-[0_18px_40px_-14px_rgba(178,30,44,0.9)] lg:hidden">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/15">✦</span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-medium">Stuck? Ask us anything</span>
              <span className="block truncate text-[12px] text-white/75">Instant help, screenshots welcome</span>
            </span>
          </button>
        )}
        {help && helpOpen && <div className="absolute inset-0 z-10 flex flex-col bg-surface lg:hidden">{help}</div>}
      </div>
    </div>
  );
}

/**
 * Instant help while they do it: they ask in their own words, paste or share a screenshot, and get the exact next
 * click. It offers to save it for the onboarding call only after several tries with them getting frustrated.
 */
function HelpChat({ slug, step, initial, onCall }: { slug: string; step: "meta" | "google"; initial: HelpTurn[]; onCall: boolean }) {
  const router = useRouter();
  const [turns, setTurns] = useState(initial);
  const [q, setQ] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(onCall);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const last = turns.at(-1);
  const offer = !saved && last?.role === "ai" && last.suggestCall && dismissed !== last.id;
  const scroll = () => requestAnimationFrame(() => end.current?.scrollIntoView({ block: "end", behavior: "smooth" }));
  const send = async (text: string) => {
    if (busy || (!text.trim() && !files.length)) return;
    setError(null);
    const sending = files;
    setBusy(sending.length ? "Looking at your screenshot…" : "Thinking…");
    try {
      let shared: { path: string; name: string; mime: string; bytes: number }[] = [];
      if (sending.length) {
        const slots = await helpSlots(slug, sending.map((f) => ({ name: f.name, bytes: f.size })));
        if (!slots.ok) throw new Error(slots.error);
        const supabase = createClient();
        shared = await Promise.all(
          sending.map(async (f, i) => {
            const { error: e } = await supabase.storage.from("client-docs").uploadToSignedUrl(slots.slots[i].path, slots.slots[i].token, f, { contentType: f.type || "application/octet-stream" });
            if (e) throw new Error(`${f.name} didn't upload. Try again.`);
            return { path: slots.slots[i].path, name: f.name, mime: f.type, bytes: f.size };
          }),
        );
      }
      setTurns((t) => [...t, { id: `me-${Date.now()}`, role: "client", text: text.trim(), files: sending.map((f) => f.name), at: new Date().toISOString(), suggestCall: false }]);
      setQ("");
      setFiles([]);
      scroll();
      const r = await askHelp(slug, step, text, shared);
      if (!r.ok) throw new Error(r.error);
      setTurns((t) => [...t.filter((x) => !x.id.startsWith("me-")), ...r.turns]);
      scroll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
        <button type="button" onClick={() => closeParams("help")} className="grid h-10 w-10 place-items-center rounded-full text-muted hover:text-fg lg:hidden" aria-label="Back to the steps">
          ←
        </button>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-brand text-white" aria-hidden>
          ✦
        </span>
        <div className="min-w-0">
          <p className="font-heading text-[16px]">Stuck? Ask us anything</p>
          <p className="text-[12.5px] leading-snug text-muted">Instant help for what&rsquo;s on your screen. Share or paste a screenshot.</p>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 content-start gap-3.5 overflow-y-auto px-4 py-4">
        {!turns.length && (
          <div className="grid gap-2">
            <p className="text-[13.5px] leading-relaxed text-muted">Can&rsquo;t find a button, seeing an error, or not sure you&rsquo;re in the right place? Tell us what you see, or send a screenshot, and we&rsquo;ll show you the next click.</p>
            {(step === "meta" ? ["I don't see Partners in the menu", "I don't have a Business Manager", "It says I don't have permission"] : ["I can't find my account ID", "I don't see the request to accept", "I have more than one account"]).map((x) => (
              <button key={x} type="button" onClick={() => void send(x)} className="min-h-11 rounded-[14px] border border-line px-3.5 py-2 text-left text-[13.5px] text-muted hover:border-faint hover:text-fg">
                {x}
              </button>
            ))}
          </div>
        )}
        {turns.map((t) =>
          t.role === "client" ? (
            <div key={t.id} className="grid justify-items-end gap-1">
              {t.text && <p className="max-w-[88%] whitespace-pre-line rounded-[18px] rounded-br-[6px] bg-fg px-4 py-2.5 text-[14px] leading-relaxed text-bg">{t.text}</p>}
              {t.files.length > 0 && <p className="text-[11.5px] text-faint">📎 {t.files.join(", ")}</p>}
            </div>
          ) : (
            <p key={t.id} className="max-w-[94%] whitespace-pre-line rounded-[18px] rounded-bl-[6px] bg-bg px-4 py-3 text-[14px] leading-relaxed">
              {t.text}
            </p>
          ),
        )}
        {busy && (
          <p className="flex items-center gap-2 text-[13px] text-faint">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> {busy}
          </p>
        )}
        {offer && (
          <div className="grid gap-2 rounded-[16px] border border-warn/40 bg-warn-soft/30 p-3.5">
            <p className="text-[13.5px]">Want to save this for our onboarding call? We&rsquo;ll do it together in a couple of minutes, and you can move on.</p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={async () => {
                  setBusy("Saving it for our call…");
                  const r = await helpToCall(slug, step);
                  setBusy(null);
                  if (!r.ok) return setError(r.error);
                  setSaved(true);
                  router.refresh();
                }}
                className="h-11 rounded-full bg-fg px-4 text-[14px] text-bg"
              >
                ☎ Save it for our call
              </button>
              <button type="button" onClick={() => setDismissed(last!.id)} className="h-11 rounded-full border border-line px-4 text-[14px] text-muted hover:text-fg">
                Keep trying
              </button>
            </div>
          </div>
        )}
        {saved && <p className="rounded-[14px] bg-warn-soft/50 px-3.5 py-2.5 text-[13px] text-warn">☎ Saved for our onboarding call. Your team knows where you got stuck.</p>}
        {error && <p className="text-[13px] text-bad">{error}</p>}
        <div ref={end} />
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(q);
        }}
        className="pb-safe border-t border-line p-3"
      >
        {files.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="inline-flex max-w-full items-center gap-1 rounded-full bg-bg px-3 py-1 text-[12px]">
                <span className="truncate">📎 {f.name}</span>
                <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="grid h-6 w-6 place-items-center text-muted hover:text-fg" aria-label={`Remove ${f.name}`}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5 rounded-[20px] border border-line bg-bg p-1.5 focus-within:border-brand-text/60">
          <button type="button" onClick={() => pick.current?.click()} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-[18px] text-muted hover:bg-surface hover:text-fg" aria-label="Share a screenshot or file">
            📎
          </button>
          <input ref={pick} type="file" multiple accept="image/*,application/pdf" hidden onChange={(e) => (setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 6)), (e.target.value = ""))} />
          <textarea
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPaste={(e) => {
              // A screenshot pasted straight in
              const pasted = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
              if (pasted.length) {
                e.preventDefault();
                setFiles([...files, ...pasted.map((f, i) => new File([f], f.name && f.name !== "image.png" ? f.name : `screenshot-${i + 1}.png`, { type: f.type }))].slice(0, 6));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(q);
              }
            }}
            rows={1}
            placeholder="What do you see?"
            className="max-h-36 min-h-11 w-full resize-none bg-transparent px-1.5 py-2.5 text-[15px] outline-none [field-sizing:content]"
          />
          <button type="submit" disabled={Boolean(busy) || (!q.trim() && !files.length)} className="h-11 shrink-0 rounded-full bg-brand px-4 text-[14px] font-medium text-white disabled:opacity-40">
            Send
          </button>
        </div>
      </form>
    </>
  );
}

function Copy({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => void navigator.clipboard?.writeText(value).then(() => setDone(true))}
      className="inline-flex min-h-11 items-center gap-2 rounded-full border border-brand/50 bg-brand/10 px-4 text-[14px]"
    >
      {label && <span className="text-muted">{label}</span>}
      <span className="tabular font-heading">{value}</span>
      <span className="text-[12px] text-brand-text">{done ? "Copied ✓" : "Copy"}</span>
    </button>
  );
}

/** A drawing of the screen they'll see: the address, the menu with the item to pick, and the spot to click */
function Screen({ url, menu, active, children }: { url: string; menu?: string[]; active?: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-[14px] border border-line bg-[#f5f6f7] text-[#1c1e21] shadow-[0_20px_50px_-24px_rgba(0,0,0,0.6)]">
      <div className="flex items-center gap-2 border-b border-[#dadde1] bg-white px-3 py-2">
        <span className="flex gap-1">
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <span key={c} className="h-2.5 w-2.5 rounded-full" style={{ background: c }} />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate rounded-full bg-[#f0f2f5] px-3 py-1 text-[11px] text-[#65676b]">{url}</span>
      </div>
      <div className="flex min-h-[170px]">
        {menu && (
          <div className="hidden w-[38%] shrink-0 border-r border-[#dadde1] bg-white p-2 sm:block">
            {menu.map((m) => (
              <p key={m} className={`relative rounded-[6px] px-2 py-1.5 text-[11.5px] ${m === active ? "bg-[#e7f3ff] font-semibold text-[#1877f2]" : m.startsWith("  ") ? "pl-5 text-[#65676b]" : "font-semibold text-[#1c1e21]"}`}>
                {m.trim()}
                {m === active && <Pulse />}
              </p>
            ))}
          </div>
        )}
        <div className="relative min-w-0 flex-1 p-3">{children}</div>
      </div>
    </div>
  );
}

function Pulse() {
  return <span aria-hidden className="pointer-events-none absolute -inset-1 animate-pulse rounded-[8px] ring-2 ring-[#c8102e]" />;
}

function Hit({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`relative inline-flex items-center rounded-[6px] bg-[#1877f2] px-3 py-1.5 text-[11.5px] font-semibold text-white ${className}`}>
      {children}
      <Pulse />
    </span>
  );
}

/** Steps one at a time, with back and next and the dots */
function Walk({ steps, last }: { steps: { title: string; body: React.ReactNode; screen: React.ReactNode }[]; last: React.ReactNode }) {
  const [i, setI] = useState(0);
  const end = i >= steps.length;
  return (
    <div className="grid gap-4">
      <div className="flex gap-1.5">
        {[...steps, null].map((_, k) => (
          <button key={k} type="button" onClick={() => setI(k)} aria-label={`Step ${k + 1}`} className={`h-1.5 flex-1 rounded-full transition-colors ${k <= i ? "bg-brand" : "bg-surface-2"}`} />
        ))}
      </div>
      {end ? (
        last
      ) : (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <p className="text-[12px] text-faint">
              Step {i + 1} of {steps.length}
            </p>
            <p className="font-heading text-[20px] leading-snug">{steps[i].title}</p>
            <div className="text-[14.5px] leading-relaxed text-muted">{steps[i].body}</div>
          </div>
          {steps[i].screen}
          <div className="flex gap-2">
            {i > 0 && (
              <button type="button" onClick={() => setI(i - 1)} className="h-12 rounded-full border border-line px-5 text-[14px] text-muted">
                Back
              </button>
            )}
            <button type="button" onClick={() => setI(i + 1)} className="h-12 flex-1 rounded-full bg-fg px-5 text-[15px] text-bg md:flex-none">
              {i === steps.length - 1 ? "I've done this →" : "Done, next →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function OnCall({ slug, which, done }: { slug: string; which: "meta" | "google"; done: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (done) return <p className="rounded-[14px] bg-warn-soft/50 px-4 py-3 text-[13.5px] text-warn">☎ Got it: we&rsquo;ll set this up together on our onboarding call.</p>;
  return open ? (
    <div className="grid gap-2 rounded-[16px] border border-line bg-surface p-3">
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Anything we should know? (optional, e.g. 'I don't have a Business Manager')" className="w-full resize-none rounded-[10px] border border-line bg-bg px-3 py-2 text-[14px] outline-none [field-sizing:content]" />
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onTheCall(slug, which, note);
          setBusy(false);
          router.refresh();
        }}
        className="h-11 rounded-full bg-fg text-[14px] text-bg disabled:opacity-50"
      >
        {busy ? "One moment…" : "Let's do it on our call"}
      </button>
    </div>
  ) : (
    <button type="button" onClick={() => setOpen(true)} className="justify-self-center text-[13.5px] text-muted underline-offset-4 hover:text-fg hover:underline">
      Stuck, or rather do it together? Let&rsquo;s do it on our call
    </button>
  );
}

const META_MENU = ["Users", "  People", "  Partners", "  System users", "Accounts", "  Pages", "  Ad accounts", "  Instagram accounts", "Data sources", "  Datasets"];

function MetaSheet({ slug, guide, bmId, adminEmails, help }: Props) {
  const router = useRouter();
  const [none, setNone] = useState(false);
  const [typed, setTyped] = useState(guide.meta.typed ?? "");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState(guide.meta);
  const verified = result.status === "verified";
  const id = bmId ?? "Ask your Kaizen contact";
  const email = adminEmails[0] ?? "Ask your Kaizen contact";
  const steps = [
    { title: "Open Business Settings", body: <>On a computer, open Meta Business Settings. Sign in with the Facebook account that owns your business&rsquo;s ad account and Page.</>, screen: (
      <Screen url="business.facebook.com/settings">
        <div className="grid h-full place-items-center gap-2 py-6 text-center">
          <p className="text-[13px] font-semibold">Business Settings</p>
          <a href="https://business.facebook.com/settings" target="_blank" rel="noreferrer" className="relative rounded-[6px] bg-[#1877f2] px-4 py-2 text-[12px] font-semibold text-white">
            Open Business Settings ↗<Pulse />
          </a>
          <p className="text-[11px] text-[#65676b]">No Business Manager yet? Tap &ldquo;I don&rsquo;t have a Business Manager&rdquo; below and we&rsquo;ll walk you through making one.</p>
        </div>
      </Screen>
    ) },
    { title: "Go to Users › Partners", body: <>In the menu on the left, under <b className="text-fg">Users</b>, click <b className="text-fg">Partners</b>.</>, screen: (
      <Screen url="business.facebook.com/settings/partners" menu={META_MENU} active="  Partners">
        <p className="text-[13px] font-semibold">Partners</p>
        <p className="mt-1 text-[11px] text-[#65676b]">Businesses you work with</p>
        <div className="mt-4"><Hit>+ Add</Hit></div>
      </Screen>
    ) },
    { title: "Add Kaizen as a partner", body: <>Click <b className="text-fg">Add</b>, then <b className="text-fg">Give a partner access to your assets</b>, and paste our Business ID:<div className="mt-3"><Copy value={id} label="Kaizen's Business ID" /></div></>, screen: (
      <Screen url="business.facebook.com/settings/partners">
        <div className="mx-auto max-w-[300px] rounded-[10px] bg-white p-3 shadow">
          <p className="text-[12.5px] font-semibold">Give a partner access</p>
          <p className="mt-2 text-[10.5px] text-[#65676b]">Partner business ID</p>
          <p className="relative mt-1 rounded-[6px] border border-[#1877f2] px-2 py-1.5 text-[12px]">{id}<Pulse /></p>
          <div className="mt-3 text-right"><Hit>Next</Hit></div>
        </div>
      </Screen>
    ) },
    { title: "Share your ad account, Page and Instagram", body: <>Pick each and turn on <b className="text-fg">full control</b> (or &ldquo;Manage&rdquo;): your <b className="text-fg">ad account</b>, <b className="text-fg">Facebook Page</b>, <b className="text-fg">Instagram account</b>, your <b className="text-fg">dataset (pixel)</b>, and your <b className="text-fg">catalog</b> if you sell online. Then <b className="text-fg">Save</b>.</>, screen: (
      <Screen url="business.facebook.com/settings/partners">
        <div className="grid gap-1.5">
          {["Ad accounts", "Pages", "Instagram accounts", "Datasets (pixels)", "Catalogs"].map((x, k) => (
            <div key={x} className="flex items-center justify-between rounded-[8px] bg-white px-2.5 py-1.5 text-[11.5px]">
              <span>{x}</span>
              <span className={`relative rounded-full px-2 py-0.5 text-[10px] font-semibold ${k < 4 ? "bg-[#1877f2] text-white" : "bg-[#e4e6eb] text-[#65676b]"}`}>
                {k < 4 ? "Full control ✓" : "If you have one"}
                {k === 0 && <Pulse />}
              </span>
            </div>
          ))}
          <div className="mt-1 text-right"><Hit>Save changes</Hit></div>
        </div>
      </Screen>
    ) },
    { title: "Add our team as an admin", body: <>Now <b className="text-fg">Users › People</b>, click <b className="text-fg">Add</b>, and invite:<div className="mt-3 flex flex-wrap gap-2">{(adminEmails.length ? adminEmails : [email]).map((e) => <Copy key={e} value={e} />)}</div><span className="mt-2 block">Pick <b className="text-fg">Full control (admin)</b>, give access to the same ad account and Page, and send the invite.</span></>, screen: (
      <Screen url="business.facebook.com/settings/people" menu={META_MENU} active="  People">
        <div className="mx-auto max-w-[300px] rounded-[10px] bg-white p-3 shadow">
          <p className="text-[12.5px] font-semibold">Invite people</p>
          <p className="relative mt-2 rounded-[6px] border border-[#1877f2] px-2 py-1.5 text-[12px]">{email}<Pulse /></p>
          <div className="mt-2 grid gap-1 text-[11px]">
            <p className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full border-[3px] border-[#1877f2]" /> <b>Full control</b> (admin)</p>
            <p className="flex items-center gap-1.5 text-[#65676b]"><span className="h-3 w-3 rounded-full border border-[#bcc0c4]" /> Everyday tasks</p>
          </div>
          <div className="mt-3 text-right"><Hit>Send invite</Hit></div>
        </div>
      </Screen>
    ) },
  ];
  return (
    <Sheet kicker="Step 1" title="Facebook & Instagram access" help={<HelpChat slug={slug} step="meta" initial={help.meta} onCall={guide.meta.status === "on_call"} />}>
      {verified ? (
        <div className="grid gap-3 rounded-[20px] border border-ok/40 bg-ok-soft/40 p-5">
          <p className="font-heading text-[20px] text-ok">✓ We&rsquo;re connected</p>
          <p className="text-[14.5px] text-muted">We can see {result.accountName ?? "your ad account"} and {result.pageName ?? "your Page"}. Nothing else to do here.</p>
        </div>
      ) : none ? (
        <Walk
          steps={MAKE_META}
          last={
            <div className="grid gap-4">
              <p className="font-heading text-[20px]">You&rsquo;re set up on Meta</p>
              <p className="text-[14.5px] leading-relaxed text-muted">Your business portfolio, Page, Instagram and ad account are ready. Now give Kaizen access to them: five quick steps.</p>
              <button type="button" onClick={() => setNone(false)} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white">
                Now give Kaizen access →
              </button>
            </div>
          }
        />
      ) : (
        <Walk
          steps={steps}
          last={
            <div className="grid gap-4">
              <p className="font-heading text-[20px]">Last thing: let us check</p>
              <p className="text-[14.5px] leading-relaxed text-muted">We&rsquo;ll look on our side to make sure we can see your ad account and Page. If you know your ad account ID (Business Settings › Ad accounts, the number under its name), add it so we find the right one.</p>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} inputMode="numeric" placeholder="Ad account ID (optional)" className="h-12 rounded-[14px] border border-line bg-surface px-4 text-[15px] outline-none focus:border-brand-text/60" />
              <button
                type="button"
                disabled={checking}
                onClick={async () => {
                  setChecking(true);
                  const r = await metaDone(slug, typed);
                  setChecking(false);
                  if (r.ok) setResult(r.step);
                  router.refresh();
                }}
                className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-60"
              >
                {checking ? "Checking on our side…" : "Check my access"}
              </button>
              {result.status === "done" && !checking && (
                <p className="rounded-[14px] bg-surface px-4 py-3 text-[13.5px] text-muted">{result.note ?? "We can't see it yet."} Meta can take a few minutes; we keep checking and your team will see the moment it lands. You can close this.</p>
              )}
            </div>
          }
        />
      )}
      {!verified && !none && (
        <button type="button" onClick={() => setNone(true)} className="mt-5 justify-self-start text-[13.5px] text-brand-text hover:underline">
          I don&rsquo;t have a Business Manager or ad account yet →
        </button>
      )}
      {!verified && none && (
        <button type="button" onClick={() => setNone(false)} className="mt-5 justify-self-start text-[13.5px] text-muted hover:text-fg">
          ← I already have one
        </button>
      )}
      {!verified && (
        <div className="mt-6 grid">
          <OnCall slug={slug} which="meta" done={guide.meta.status === "on_call"} />
        </div>
      )}
    </Sheet>
  );
}

/** No business portfolio (Business Manager) yet: make one, add the Page and Instagram, and make the ad account */
const MAKE_META: { title: string; body: React.ReactNode; screen: React.ReactNode }[] = [
  {
    title: "Make a business portfolio",
    body: <>On a computer, go to <a className="text-brand-text underline" href="https://business.facebook.com/overview" target="_blank" rel="noreferrer">business.facebook.com/overview</a>, signed in with your own Facebook account, and click <b className="text-fg">Create a business portfolio</b>. (Meta used to call this Business Manager.)</>,
    screen: (
      <Screen url="business.facebook.com/overview">
        <div className="grid place-items-center gap-2 py-6 text-center">
          <p className="text-[13px] font-semibold">Meta Business Suite</p>
          <Hit>Create a business portfolio</Hit>
        </div>
      </Screen>
    ),
  },
  {
    title: "Name it and add your details",
    body: <>Type your <b className="text-fg">business name</b> (as customers know it), <b className="text-fg">your name</b> and your <b className="text-fg">business email</b>, then <b className="text-fg">Create</b>. Meta emails you to confirm: click the link in that email.</>,
    screen: (
      <Screen url="business.facebook.com/overview">
        <div className="mx-auto grid max-w-[300px] gap-1.5 rounded-[10px] bg-white p-3 text-[11.5px] shadow">
          <p className="text-[12.5px] font-semibold">Create a business portfolio</p>
          {["Business portfolio name", "Your name", "Business email"].map((x) => (
            <p key={x} className="rounded-[6px] border border-[#dadde1] px-2 py-1.5 text-[#65676b]">{x}</p>
          ))}
          <div className="text-right"><Hit>Create</Hit></div>
        </div>
      </Screen>
    ),
  },
  {
    title: "Add your Facebook Page",
    body: <>Open <a className="text-brand-text underline" href="https://business.facebook.com/settings" target="_blank" rel="noreferrer">Business Settings</a>, then <b className="text-fg">Accounts › Pages › Add › Add a Page</b>, and pick your business&rsquo;s Page. No Page yet? Choose <b className="text-fg">Create a new Page</b>.</>,
    screen: (
      <Screen url="business.facebook.com/settings/pages" menu={META_MENU} active="  Pages">
        <p className="text-[13px] font-semibold">Pages</p>
        <div className="mt-3 grid gap-1.5 text-[11.5px]">
          <Hit>+ Add</Hit>
          <p className="rounded-[6px] bg-white px-2 py-1.5">Add a Page</p>
          <p className="rounded-[6px] bg-white px-2 py-1.5 text-[#65676b]">Create a new Page</p>
        </div>
      </Screen>
    ),
  },
  {
    title: "Connect Instagram",
    body: <>Still in Business Settings: <b className="text-fg">Accounts › Instagram accounts › Add</b>, and log in to your business&rsquo;s Instagram.</>,
    screen: (
      <Screen url="business.facebook.com/settings/instagram-accounts" menu={META_MENU} active="  Instagram accounts">
        <p className="text-[13px] font-semibold">Instagram accounts</p>
        <div className="mt-3"><Hit>+ Add</Hit></div>
      </Screen>
    ),
  },
  {
    title: "Make your ad account",
    body: <><b className="text-fg">Accounts › Ad accounts › Add › Create a new ad account</b>. Name it after your business, and pick your <b className="text-fg">time zone</b> and <b className="text-fg">currency</b> carefully (they can&rsquo;t change later). Choose <b className="text-fg">My business</b>, then <b className="text-fg">Create</b>.</>,
    screen: (
      <Screen url="business.facebook.com/settings/ad-accounts" menu={META_MENU} active="  Ad accounts">
        <div className="mx-auto grid max-w-[300px] gap-1.5 rounded-[10px] bg-white p-3 text-[11.5px] shadow">
          <p className="text-[12.5px] font-semibold">Create a new ad account</p>
          {["Ad account name: Your business", "Time zone: (GMT-05:00) Eastern", "Currency: USD"].map((x) => (
            <p key={x} className="rounded-[6px] border border-[#dadde1] px-2 py-1.5">{x}</p>
          ))}
          <div className="text-right"><Hit>Create</Hit></div>
        </div>
      </Screen>
    ),
  },
  {
    title: "Add a payment method",
    body: <>Open <a className="text-brand-text underline" href="https://business.facebook.com/billing_hub/payment_settings" target="_blank" rel="noreferrer">Billing &amp; payments</a>, pick your new ad account, and <b className="text-fg">Add payment method</b>. Your ads are billed to you directly by Meta.</>,
    screen: (
      <Screen url="business.facebook.com/billing_hub/payment_settings">
        <div className="grid place-items-center gap-2 py-6 text-center">
          <p className="text-[13px] font-semibold">Payment methods</p>
          <Hit>Add payment method</Hit>
        </div>
      </Screen>
    ),
  },
];

function GoogleSheet({ slug, guide, managerId, help }: Props) {
  const router = useRouter();
  const [id, setId] = useState(guide.google.account ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState(guide.google);
  const [none, setNone] = useState(false);
  const fmt = (v: string) => {
    const d = v.replace(/\D/g, "").slice(0, 10);
    return [d.slice(0, 3), d.slice(3, 6), d.slice(6)].filter(Boolean).join("-");
  };
  const send = async () => {
    setBusy(true);
    setError(null);
    const r = await googleSend(slug, id);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setResult(r.step);
    router.refresh();
  };
  return (
    <Sheet kicker="Step 2" title="Google Ads" help={<HelpChat slug={slug} step="google" initial={help.google} onCall={guide.google.status === "on_call"} />}>
      {result.status === "verified" ? (
        <div className="grid gap-3 rounded-[20px] border border-ok/40 bg-ok-soft/40 p-5">
          <p className="font-heading text-[20px] text-ok">✓ Connected</p>
          <p className="text-[14.5px] text-muted">Your account {result.account} is linked to Kaizen. Nothing else to do here.</p>
        </div>
      ) : result.status === "invited" || result.status === "sent" ? (
        <div className="grid gap-4">
          <p className="font-heading text-[20px]">Thanks! One click left</p>
          <p className="text-[14.5px] leading-relaxed text-muted">
            We&rsquo;ve asked to manage {result.account}
            {managerId ? ` from Kaizen's account (${managerId})` : ""}. In Google Ads, open <b className="text-fg">Admin › Access and security › Managers</b> and click <b className="text-fg">Accept</b>.
          </p>
          <Screen url="ads.google.com/aw/accountaccess/managers" menu={["Admin", "  Account settings", "  Access and security", "  Linked accounts"]} active="  Access and security">
            <div className="flex gap-3 border-b border-[#dadde1] pb-1 text-[11px]">
              <span className="text-[#65676b]">Users</span>
              <span className="relative font-semibold text-[#1a73e8]">Managers<Pulse /></span>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-[8px] bg-white px-2.5 py-2 text-[11.5px]">
              <span>Kaizen Marketing{managerId ? ` · ${managerId}` : ""}</span>
              <Hit className="!bg-[#1a73e8]">Accept</Hit>
            </div>
          </Screen>
          {result.note && <p className="text-[12.5px] text-faint">{result.note}</p>}
        </div>
      ) : none ? (
        <Walk
          steps={[
            { title: "Start at Google Ads", body: <>Go to <a className="text-brand-text underline" href="https://ads.google.com/home/" target="_blank" rel="noreferrer">ads.google.com</a> and click <b className="text-fg">Start now</b>. Sign in with your business Google account.</>, screen: <Screen url="ads.google.com"><div className="grid place-items-center py-8"><Hit className="!bg-[#1a73e8]">Start now</Hit></div></Screen> },
            { title: "Skip the first campaign", body: <>When it asks to make a campaign, look for <b className="text-fg">Switch to Expert Mode</b> (small, at the bottom), then <b className="text-fg">Create an account without a campaign</b>. We&rsquo;ll build the campaigns.</>, screen: <Screen url="ads.google.com/aw/signup"><div className="grid gap-3 py-4 text-center"><p className="text-[12px]">What&rsquo;s your main advertising goal?</p><p className="relative mx-auto text-[11px] text-[#1a73e8]">Switch to Expert Mode<Pulse /></p></div></Screen> },
            { title: "Confirm your business details", body: <>Check the country, time zone and currency (these can&rsquo;t change later), then <b className="text-fg">Submit</b>.</>, screen: <Screen url="ads.google.com/aw/signup"><div className="grid gap-1.5 text-[11.5px]">{["Billing country: United States", "Time zone: (GMT-05:00) Eastern", "Currency: US Dollar (USD $)"].map((x) => <p key={x} className="rounded-[6px] bg-white px-2 py-1.5">{x}</p>)}<div className="text-right"><Hit className="!bg-[#1a73e8]">Submit</Hit></div></div></Screen> },
          ]}
          last={<Find id={id} setId={setId} fmt={fmt} send={send} busy={busy} error={error} />}
        />
      ) : (
        <div className="grid gap-4">
          <p className="font-heading text-[20px]">Find your account ID</p>
          <p className="text-[14.5px] leading-relaxed text-muted">Open Google Ads. Your 10-digit ID is in the top right, next to your account name.</p>
          <Screen url="ads.google.com/aw/overview">
            <div className="flex items-start justify-between">
              <span className="text-[12px] font-semibold text-[#5f6368]">Google Ads</span>
              <span className="relative rounded-[6px] bg-white px-2 py-1 text-right text-[10.5px] leading-tight">
                Your business
                <br />
                <b className="tabular text-[12px]">123-456-7890</b>
                <Pulse />
              </span>
            </div>
            <div className="mt-6 grid grid-cols-3 gap-2">
              {[0, 1, 2].map((k) => (
                <span key={k} className="h-10 rounded-[6px] bg-white" />
              ))}
            </div>
          </Screen>
          <Find id={id} setId={setId} fmt={fmt} send={send} busy={busy} error={error} />
          <button type="button" onClick={() => setNone(true)} className="justify-self-start text-[13.5px] text-brand-text hover:underline">
            I don&rsquo;t have a Google Ads account →
          </button>
        </div>
      )}
      {result.status !== "verified" && (
        <div className="mt-6 grid">
          <OnCall slug={slug} which="google" done={guide.google.status === "on_call"} />
        </div>
      )}
    </Sheet>
  );
}

function Find({ id, setId, fmt, send, busy, error }: { id: string; setId: (v: string) => void; fmt: (v: string) => string; send: () => void; busy: boolean; error: string | null }) {
  return (
    <div className="grid gap-2">
      <input value={id} onChange={(e) => setId(fmt(e.target.value))} inputMode="numeric" placeholder="123-456-7890" className="tabular h-14 rounded-[14px] border border-line bg-surface px-4 text-center font-heading text-[22px] tracking-wider outline-none focus:border-brand-text/60" />
      <button type="button" disabled={busy || id.replace(/\D/g, "").length !== 10} onClick={send} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-40">
        {busy ? "Sending…" : "Send it to Kaizen"}
      </button>
      {error && <p className="text-[13px] text-bad">{error}</p>}
    </div>
  );
}

const WANT = ["Logo", "Brand guide, fonts and colors", "Product or service photos", "Videos (any you have)", "Team and location photos", "Reviews and testimonials", "Ads that worked before"];

function AssetsSheet({ slug, guide }: Props) {
  const router = useRouter();
  const pick = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [links, setLinks] = useState<string[]>([""]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [over, setOver] = useState(false);
  const had = (guide.assets.files ?? 0) + (guide.assets.links ?? 0);
  const send = async () => {
    setError(null);
    try {
      const uploaded: { path: string; name: string; mime: string; bytes: number }[] = [];
      if (files.length) {
        const slots = await assetSlots(slug, files.map((f) => ({ name: f.name, bytes: f.size })));
        if (!slots.ok) throw new Error(slots.error);
        const supabase = createClient();
        for (let i = 0; i < files.length; i++) {
          setBusy(`Uploading ${i + 1} of ${files.length}…`);
          const { error: e } = await supabase.storage.from("client-docs").uploadToSignedUrl(slots.slots[i].path, slots.slots[i].token, files[i], { contentType: files[i].type || "application/octet-stream" });
          if (e) throw new Error(`${files[i].name} didn't upload. Try again.`);
          uploaded.push({ path: slots.slots[i].path, name: files[i].name, mime: files[i].type, bytes: files[i].size });
        }
      }
      setBusy("Sending it to the team…");
      const r = await assetsShared(slug, uploaded, links);
      if (!r.ok) throw new Error(r.error);
      setFiles([]);
      setLinks([""]);
      setSent(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Try again.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Sheet kicker="Step 3" title="Your brand assets">
      <div className="grid gap-5">
        {(sent || had > 0) && <p className="rounded-[14px] bg-ok-soft/50 px-4 py-3 text-[13.5px] text-ok">✓ {sent ? "Got them, thank you! They're with the team now." : `You've shared ${had} so far.`} Add more any time.</p>}
        <div className="grid gap-2">
          <p className="text-[14.5px] leading-relaxed text-muted">Whatever you have helps the first ads look like you. Great to have:</p>
          <div className="flex flex-wrap gap-1.5">
            {WANT.map((w) => (
              <span key={w} className="rounded-full bg-surface-2 px-3 py-1 text-[12.5px] text-muted">
                {w}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => pick.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            setFiles([...files, ...Array.from(e.dataTransfer.files)].slice(0, 30));
          }}
          className={`grid place-items-center gap-2 rounded-[22px] border-2 border-dashed px-4 py-10 text-center transition-colors ${over ? "border-brand bg-brand/10" : "border-line bg-surface hover:border-faint"}`}
        >
          <span className="grid h-14 w-14 place-items-center rounded-full bg-brand/15 text-[24px] text-brand-text">⇪</span>
          <span className="font-heading text-[17px]">Drop files here, or tap to choose</span>
          <span className="text-[12.5px] text-faint">Photos, videos, PDFs, up to 200 MB each</span>
        </button>
        <input ref={pick} type="file" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 30))} />
        {files.length > 0 && (
          <div className="grid gap-1.5">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} className="flex items-center gap-3 rounded-[12px] bg-surface px-3 py-2 text-[13.5px]">
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
                <span className="tabular shrink-0 text-[12px] text-faint">{(f.size / 1_000_000).toFixed(1)} MB</span>
                <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))} className="grid h-9 w-9 place-items-center rounded-full text-muted hover:text-fg" aria-label={`Remove ${f.name}`}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="grid gap-2">
          <p className="text-[13.5px] text-muted">Or share a link (Google Drive, Dropbox, WeTransfer, Canva…)</p>
          {links.map((l, i) => (
            <input
              key={i}
              value={l}
              onChange={(e) => {
                const next = [...links];
                next[i] = e.target.value;
                if (i === links.length - 1 && e.target.value.trim() && links.length < 12) next.push("");
                setLinks(next);
              }}
              placeholder="https://"
              className="h-12 rounded-[14px] border border-line bg-surface px-4 text-[14.5px] outline-none focus:border-brand-text/60"
            />
          ))}
        </div>
        <button type="button" disabled={Boolean(busy) || (!files.length && !links.some((l) => l.trim()))} onClick={send} className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-40">
          {busy ?? `Send ${files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "it"} to Kaizen`}
        </button>
        {error && <p className="text-[13px] text-bad">{error}</p>}
      </div>
    </Sheet>
  );
}

function StyleSheet({ slug, guide, examples }: Props) {
  const router = useRouter();
  const [styles, setStyles] = useState<string[]>(guide.style.styles ?? []);
  const [pacing, setPacing] = useState<string | null>(guide.style.pacing ?? null);
  const [liked, setLiked] = useState<StyleStep["liked"]>(guide.style.liked ?? []);
  const [note, setNote] = useState(guide.style.note ?? "");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (k: string) => setStyles(styles.includes(k) ? styles.filter((x) => x !== k) : [...styles, k]);
  const tint = ["#b21e2c", "#5b8def", "#16794c", "#c98a14", "#8b5cf6", "#0ea5e9", "#e0505c", "#f97316"];
  return (
    <Sheet kicker="Step 4" title="The look you want">
      <div className="grid gap-6">
        <div className="grid gap-3">
          <p className="font-heading text-[18px]">Which styles feel like you?</p>
          <p className="-mt-2 text-[13.5px] text-muted">Pick as many as you like.</p>
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            {STYLES.map((x, k) => {
              const on = styles.includes(x.key);
              return (
                <button key={x.key} type="button" onClick={() => toggle(x.key)} className={`grid content-start gap-2 overflow-hidden rounded-[18px] border p-0 text-left transition-colors ${on ? "border-brand ring-1 ring-brand" : "border-line"}`}>
                  {/* A phone-sized frame in the style's colour: a picture of the kind of ad, not a real one */}
                  <span className="relative block aspect-[4/5] w-full" style={{ background: `linear-gradient(160deg, ${tint[k]}55, ${tint[k]}11 70%)` }}>
                    <span aria-hidden className="absolute inset-0 grid place-items-center text-[44px] md:text-[52px]">{["🤳", "🎙️", "⭐", "▶️", "🌴", "✨", "Aa", "😂"][k]}</span>
                    <span className="absolute inset-x-3 bottom-3 grid gap-1">
                      <span className="h-1.5 w-2/3 rounded-full bg-white/70" />
                      <span className="h-1.5 w-1/2 rounded-full bg-white/40" />
                    </span>
                    {on && <span className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full bg-brand text-[13px] text-white">✓</span>}
                  </span>
                  <span className="grid gap-0.5 px-3 pb-3">
                    <span className="font-heading text-[14.5px] leading-snug">{x.name}</span>
                    <span className="text-[12px] leading-snug text-muted">{x.line}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-3">
          <p className="font-heading text-[18px]">How fast should it move?</p>
          <div className="grid gap-2 md:grid-cols-3">
            {PACING.map((x, k) => (
              <button key={x.key} type="button" onClick={() => setPacing(x.key)} className={`grid gap-2 rounded-[18px] border p-4 text-left ${pacing === x.key ? "border-brand bg-brand/[0.06]" : "border-line bg-surface"}`}>
                {/* The rhythm, as cuts: more bars, shorter shots */}
                <span className="flex h-6 items-end gap-[3px]">
                  {Array.from({ length: [12, 6, 3][k] }).map((_, j) => (
                    <span key={j} className={`flex-1 rounded-[2px] ${pacing === x.key ? "bg-brand" : "bg-faint/50"}`} style={{ height: `${40 + ((j * 37) % 60)}%` }} />
                  ))}
                </span>
                <span className="font-heading text-[15px]">{x.name}</span>
                <span className="text-[12.5px] text-muted">{x.line}</span>
              </button>
            ))}
          </div>
        </div>

        {examples.length > 0 && (
          <div className="grid gap-3">
            <p className="font-heading text-[18px]">Ads that are winning in your industry</p>
            <p className="-mt-2 text-[13.5px] text-muted">Tap the ones you&rsquo;d love yours to feel like (they&rsquo;re from other brands, shown just for the style).</p>
            <div className="grid grid-cols-3 gap-2 md:grid-cols-4">
              {examples.map((x) => {
                const on = (liked ?? []).some((l) => l.image === x.image);
                return (
                  <button key={x.id} type="button" onClick={() => setLiked(on ? (liked ?? []).filter((l) => l.image !== x.image) : [...(liked ?? []), { image: x.image, label: x.video ? "Video" : "Image" }])} className={`relative overflow-hidden rounded-[14px] border ${on ? "border-brand ring-2 ring-brand" : "border-line"}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={x.image} alt="" className="aspect-[4/5] w-full object-cover" loading="lazy" />
                    <span className={`absolute right-1.5 top-1.5 grid h-8 w-8 place-items-center rounded-full text-[15px] ${on ? "bg-brand text-white" : "bg-black/40 text-white"}`}>{on ? "♥" : "♡"}</span>
                    {x.video && <span className="absolute bottom-1.5 left-1.5 rounded-full bg-black/50 px-2 py-0.5 text-[10.5px] text-white">▶ Video</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="grid gap-2">
          <p className="font-heading text-[18px]">Anything else?</p>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="Brands or ads you love, things you never want to see, a link to an ad you saw…" className="w-full resize-none rounded-[14px] border border-line bg-surface px-4 py-3 text-[15px] leading-relaxed outline-none [field-sizing:content] focus:border-brand-text/60" />
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            const r = await saveStyle(slug, { styles, pacing, liked, note });
            setBusy(false);
            if (!r.ok) return setError(r.error);
            setSaved(true);
            router.refresh();
          }}
          className="h-12 rounded-full bg-brand text-[15px] font-medium text-white disabled:opacity-50"
        >
          {busy ? "Saving…" : saved ? "Saved ✓ (save again to update)" : "Save my look"}
        </button>
        {error && <p className="text-[13px] text-bad">{error}</p>}
      </div>
    </Sheet>
  );
}
