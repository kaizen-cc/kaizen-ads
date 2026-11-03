"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { CALLS, sectionsOf, type CallType, type IntakeForm, type IntakeQuestion } from "@/lib/intake-questions";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";
import { callDetails, prepareIntake, saveIntake, sendIntake } from "./actions";

// The marketing intake as a few short screens, one topic each (in the address, so back returns to the last one): their
// questions, what we already know filled in for them to confirm, saved as they type so they can stop and come back.
// The last screen books their onboarding call, the kind picked from where their setup stands.

type Call = { type: CallType; reason: string; computer: string | null; booked: boolean };
type Props = { slug: string; brand: string; firstName: string | null; who: { name: string; email: string } | null; form: IntakeForm | null; answers: Record<string, string>; sent: boolean; call: Call | null };

const valueOf = (q: IntakeQuestion, a: Record<string, string>) => (q.id in a ? a[q.id] : (q.prefill ?? ""));
const noop = () => () => {};

export function IntakeView(p: Props) {
  const [form, setForm] = useState(p.form);
  const [answers, setAnswers] = useState(p.answers);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(p.sent);
  const [call, setCall] = useState(p.call);

  // The first open: their questions are written for them (once), then kept
  const asked = useRef(false);
  useEffect(() => {
    if (form || asked.current) return;
    asked.current = true;
    void prepareIntake(p.slug).then((r) => {
      if (!r.ok) return setError(r.error);
      setForm(r.form);
      setAnswers((a) => ({ ...r.answers, ...a }));
    });
  }, [form, p.slug]);

  if (!form)
    return (
      <Shell brand={p.brand} title="Tell us about your business" pct={0}>
        <div className="grid place-items-center gap-4 rounded-[24px] border border-line bg-surface px-6 py-16 text-center">
          {error ? (
            <>
              <p className="text-[15px] text-muted">{error}</p>
              <button type="button" onClick={() => location.reload()} className="h-11 rounded-full bg-brand px-6 text-[14px] font-medium text-white">
                Try again
              </button>
            </>
          ) : (
            <>
              <span className="h-10 w-10 animate-spin rounded-full border-[3px] border-line border-t-brand" />
              <p className="font-heading text-[19px]">Writing your questions…</p>
              <p className="max-w-md text-[14px] leading-relaxed text-muted">We&rsquo;re picking the questions that matter for {p.brand} and filling in what you&rsquo;ve already told us, so you only answer what we don&rsquo;t know. About half a minute.</p>
            </>
          )}
        </div>
      </Shell>
    );
  return <Form {...p} form={form} answers={answers} setAnswers={setAnswers} sent={sent} setSent={setSent} call={call} setCall={setCall} />;
}

function Form(p: Props & { form: IntakeForm; setAnswers: React.Dispatch<React.SetStateAction<Record<string, string>>>; setSent: (v: boolean) => void; setCall: (c: Call) => void }) {
  const { form, answers, setAnswers } = p;
  const sections = useMemo(() => sectionsOf(form), [form]);
  const param = useParam("s");
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [sending, setSending] = useState(false);

  // Where they are: the screen in the address; otherwise the first with something still to answer
  const firstOpen = sections.find((s) => form.questions.some((q) => q.section === s.key && q.required && !valueOf(q, answers).trim()))?.key ?? sections[0]?.key;
  const current = p.sent ? "call" : param && (param === "call" || sections.some((s) => s.key === param)) ? param : firstOpen;
  const index = sections.findIndex((s) => s.key === current);
  const total = form.questions.length;
  const done = form.questions.filter((q) => valueOf(q, answers).trim()).length;
  const pct = p.sent ? 100 : Math.round((done / Math.max(1, total)) * 100);

  // Saved as they type (a moment after they stop), so they can close it and come back
  const dirty = useRef<Record<string, string>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    const batch = dirty.current;
    if (!Object.keys(batch).length) return;
    dirty.current = {};
    setSaving("saving");
    const r = await saveIntake(p.slug, batch);
    setSaving(r.ok ? "saved" : "idle");
    if (!r.ok) setError(r.error);
  }, [p.slug]);
  const set = (id: string, v: string) => {
    setAnswers((a) => ({ ...a, [id]: v }));
    dirty.current[id] = v;
    setMissing((m) => m.filter((x) => x !== id));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), 1200);
  };
  useEffect(() => {
    const away = () => void flush();
    window.addEventListener("pagehide", away);
    return () => window.removeEventListener("pagehide", away);
  }, [flush]);

  const go = async (key: string) => {
    await flush();
    pushParams({ s: key });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const send = async () => {
    setSending(true);
    setError(null);
    await flush();
    // Everything as it stands, prefilled answers they left as they were included
    const all = Object.fromEntries(form.questions.map((q) => [q.id, valueOf(q, answers)]));
    const r = await sendIntake(p.slug, all);
    setSending(false);
    if (!r.ok) {
      setError(r.error);
      if (r.missing?.length) {
        setMissing(r.missing);
        const first = form.questions.find((q) => q.id === r.missing![0]);
        if (first) replaceParams({ s: first.section });
      }
      return;
    }
    p.setSent(true);
    p.setCall({ type: r.call.type, reason: r.call.reason, computer: null, booked: false });
    replaceParams({ s: "call" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  if (current === "call" && p.sent && p.call) return <CallStep {...p} call={p.call} setCall={p.setCall} />;

  const section = sections[Math.max(0, index)];
  const questions = form.questions.filter((q) => q.section === section.key);
  const last = index === sections.length - 1;

  return (
    <Shell brand={p.brand} title={p.firstName ? `${p.firstName}, tell us about ${p.brand}` : `Tell us about ${p.brand}`} pct={pct} line={`About ten minutes. Saved as you go, so you can stop and pick up later.${form.industry ? ` Tailored for a ${form.industry.toLowerCase()}.` : ""}`}>
      {/* The screens, as dots: jump back to any */}
      <nav className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1" aria-label="Sections">
        {sections.map((s, i) => {
          const qs = form.questions.filter((q) => q.section === s.key);
          const full = qs.every((q) => !q.required || valueOf(q, answers).trim());
          return (
            <button key={s.key} type="button" onClick={() => void go(s.key)} className={`shrink-0 rounded-full px-3.5 py-2 text-[12.5px] transition-colors ${s.key === section.key ? "bg-fg text-ink" : full && qs.some((q) => valueOf(q, answers).trim()) ? "bg-ok-soft text-ok" : "bg-surface-2 text-muted hover:text-fg"}`}>
              {i + 1}. {s.title}
            </button>
          );
        })}
      </nav>

      <section className="grid gap-4 rounded-[24px] border border-line bg-surface p-5 md:p-8">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">
            {index + 1} of {sections.length}
          </p>
          <h2 className="mt-1.5 font-heading text-[24px] leading-tight md:text-[28px]">{section.title}</h2>
          <p className="mt-1 text-[14px] text-muted">{section.line}</p>
        </div>
        <div className="grid gap-6">
          {questions.map((q) => (
            <Question key={q.id} q={q} value={valueOf(q, answers)} touched={q.id in answers} missing={missing.includes(q.id)} set={(v) => set(q.id, v)} />
          ))}
        </div>
      </section>

      {error && <p className="rounded-[14px] border border-bad/40 bg-bad-soft/40 px-4 py-3 text-[13.5px] text-bad">{error}</p>}

      {/* Back and next, always in reach on a phone */}
      <div className="sticky bottom-3 z-10 flex items-center gap-3 rounded-full border border-line bg-surface/95 p-2 shadow-[0_18px_40px_-20px_rgba(0,0,0,0.5)] backdrop-blur">
        <button type="button" disabled={index <= 0} onClick={() => void go(sections[index - 1].key)} className="h-12 rounded-full px-5 text-[14.5px] text-muted hover:text-fg disabled:opacity-30">
          ← Back
        </button>
        <span className="flex-1 text-center text-[12px] text-faint">{saving === "saving" ? "Saving…" : saving === "saved" ? "Saved ✓" : `${done} of ${total} answered`}</span>
        {last ? (
          <button type="button" disabled={sending} onClick={() => void send()} className="h-12 rounded-full bg-brand px-6 text-[15px] font-medium text-white hover:bg-brand-hover disabled:opacity-60">
            {sending ? "Sending…" : "Send my answers"}
          </button>
        ) : (
          <button type="button" onClick={() => void go(sections[index + 1].key)} className="h-12 rounded-full bg-brand px-6 text-[15px] font-medium text-white hover:bg-brand-hover">
            Next →
          </button>
        )}
      </div>
    </Shell>
  );
}

function Question({ q, value, touched, missing, set }: { q: IntakeQuestion; value: string; touched: boolean; missing: boolean; set: (v: string) => void }) {
  const guessed = Boolean(q.prefill) && !touched;
  const picked = q.kind === "many" ? value.split(";").map((x) => x.trim()).filter(Boolean) : [];
  return (
    <div className={`grid gap-2.5 ${missing ? "rounded-[16px] ring-2 ring-bad/50 ring-offset-4 ring-offset-surface" : ""}`}>
      <label htmlFor={`q-${q.id}`} className="font-heading text-[17px] leading-snug">
        {q.q}
        {q.required && <span className="ml-1 text-brand-text">*</span>}
      </label>
      {q.help && <p className="-mt-1 text-[13px] leading-relaxed text-faint">{q.help}</p>}
      {guessed && (
        <div className="flex flex-wrap items-center gap-2 rounded-[12px] bg-brand/[0.07] px-3 py-2 text-[12.5px] text-brand-text">
          <span>✦ We filled this in from what you&rsquo;ve told us. Change anything that&rsquo;s off.</span>
          <button type="button" onClick={() => set(value)} className="rounded-full border border-brand/40 px-2.5 py-0.5 text-[12px] hover:bg-brand/10">
            Looks right
          </button>
        </div>
      )}
      {q.kind === "long" && <AutoText id={`q-${q.id}`} value={value} onChange={set} />}
      {q.kind === "short" && <input id={`q-${q.id}`} value={value} onChange={(e) => set(e.target.value)} className="h-12 rounded-[14px] border border-line bg-ink px-4 text-[15px] outline-none focus:border-brand-text/60" />}
      {(q.kind === "one" || q.kind === "many") && (
        <div className="flex flex-wrap gap-2" role={q.kind === "one" ? "radiogroup" : "group"} aria-label={q.q}>
          {(q.options ?? []).map((o) => {
            const on = q.kind === "one" ? value === o : picked.includes(o);
            return (
              <button
                key={o}
                type="button"
                aria-pressed={on}
                onClick={() => set(q.kind === "one" ? (on ? "" : o) : (on ? picked.filter((x) => x !== o) : [...picked, o]).join("; "))}
                className={`min-h-11 rounded-full border px-4 text-[14px] transition-colors ${on ? "border-brand bg-brand text-white" : "border-line bg-ink text-fg hover:border-faint"}`}
              >
                {on && q.kind === "many" ? "✓ " : ""}
                {o}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A box that grows with what they write */
function AutoText({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(420, Math.max(96, el.scrollHeight))}px`;
  }, [value]);
  return <textarea ref={ref} id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={3} className="resize-none rounded-[14px] border border-line bg-ink px-4 py-3 text-[15px] leading-relaxed outline-none focus:border-brand-text/60" />;
}

/** Booking the onboarding call: the kind that fits where their setup stands, the calendar right here */
function CallStep(p: Props & { call: Call; setCall: (c: Call) => void }) {
  const kind = CALLS[p.call.type];
  const [computer, setComputer] = useState(p.call.computer);
  const [booked, setBooked] = useState(p.call.booked);
  // The page's own host, for Calendly's embed (only known in the browser)
  const origin = useSyncExternalStore(noop, () => window.location.host, () => null);
  // Calendly tells the page when they've booked
  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (!String(e.origin).includes("calendly.com")) return;
      if ((e.data as { event?: string } | null)?.event === "calendly.event_scheduled") {
        setBooked(true);
        void callDetails(p.slug, { booked: true });
      }
    };
    window.addEventListener("message", on);
    return () => window.removeEventListener("message", on);
  }, [p.slug]);
  const params = new URLSearchParams({ hide_gdpr_banner: "1", embed_type: "Inline", ...(origin ? { embed_domain: origin } : {}), ...(p.who?.name ? { name: p.who.name } : {}), ...(p.who?.email ? { email: p.who.email } : {}) });
  const src = `${kind.url}?${params}`;

  return (
    <Shell brand={p.brand} title="Thank you! Last step: your onboarding call" pct={100} line="Your answers are in. Your strategist reads them before the call, and they're what your brand plan is built from.">
      <section className="grid gap-5 rounded-[24px] border border-line bg-surface p-5 md:p-8">
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-brand-text">For you</p>
          <h2 className="font-heading text-[24px] leading-tight md:text-[28px]">{kind.name}</h2>
          <p className="text-[14.5px] leading-relaxed text-muted">{p.call.reason}</p>
          <p className="text-[14px] leading-relaxed text-muted">{kind.line}</p>
        </div>
        <div className="grid gap-2">
          <p className="font-heading text-[17px]">Which computer will you join from?</p>
          <p className="-mt-1 text-[13px] text-faint">Please join this one from a laptop or desktop, so you can share your screen. Any other call, your phone is fine.</p>
          <div className="flex flex-wrap gap-2">
            {(["Apple", "PC/Windows"] as const).map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={computer === c}
                onClick={() => {
                  setComputer(c);
                  void callDetails(p.slug, { computer: c });
                }}
                className={`min-h-11 rounded-full border px-5 text-[14px] ${computer === c ? "border-brand bg-brand text-white" : "border-line bg-ink hover:border-faint"}`}
              >
                {c === "Apple" ? "Mac" : "Windows PC"}
              </button>
            ))}
          </div>
        </div>
        {booked ? (
          <div className="grid gap-3 rounded-[20px] border border-ok/40 bg-ok-soft/40 p-5">
            <p className="font-heading text-[20px] text-ok">✓ You&rsquo;re booked</p>
            <p className="text-[14.5px] text-muted">The invite is in your inbox. We&rsquo;ll come prepared with your answers and your setup.</p>
            <Link href={`/c/${p.slug}/start`} className="justify-self-start text-[14px] text-brand-text hover:underline">
              ← Back to your setup
            </Link>
          </div>
        ) : (
          <div className="grid gap-2">
            <div className="overflow-hidden rounded-[18px] border border-line bg-white">
              {origin && <iframe title={kind.name} src={src} className="h-[720px] w-full md:h-[680px]" />}
            </div>
            <a href={src} target="_blank" rel="noreferrer" className="justify-self-start text-[13px] text-muted hover:text-fg">
              Calendar not showing? Open it in a new tab ↗
            </a>
          </div>
        )}
      </section>
    </Shell>
  );
}

function Shell({ brand, title, line, pct, children }: { brand: string; title: string; line?: string; pct: number; children: React.ReactNode }) {
  return (
    <div className="grid gap-5">
      <section className="relative isolate overflow-hidden rounded-[28px] border border-line bg-deep px-5 pb-6 pt-7 md:px-10 md:pb-9 md:pt-10">
        <span aria-hidden className="pointer-events-none absolute -right-24 -top-32 -z-10 h-96 w-96 rounded-full bg-brand/30 blur-[120px]" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-faint">Kaizen Marketing · {brand}</p>
        <h1 className="mt-2 font-heading text-[26px] leading-[1.1] tracking-tight md:text-[38px]">{title}</h1>
        {line && <p className="mt-3 max-w-2xl text-[14.5px] leading-relaxed text-muted">{line}</p>}
        <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-line">
          <div className="h-full rounded-full bg-brand transition-[width] duration-500" style={{ width: `${pct}%` }} />
        </div>
      </section>
      {children}
    </div>
  );
}
