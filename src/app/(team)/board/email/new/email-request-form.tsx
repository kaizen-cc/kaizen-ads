"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Combobox } from "@/components/combobox";
import { toast } from "@/components/toasts";
import { tintFor } from "@/lib/colors";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";
import { KIND_LABEL, MAX_MESSAGES, type EmailKind, type EmailPriority } from "@/lib/email-board-core";
import { createEmailTicket, suggestionsFor, writeEmailBrief, type BriefDraft, type Idea } from "./actions";

type ClientOption = { id: string; name: string; slug: string };
const field = "w-full rounded-[12px] border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand-text";
const SOURCE: Record<Idea["source"], string> = { client: "For this client", elsewhere: "Worked for another client", starter: "Every store needs one" };

export function EmailRequestForm({ clients, initialClient }: { clients: ClientOption[]; initialClient: string | null }) {
  const router = useRouter();
  const clientSlug = useParam("client");
  const clientId = clients.find((c) => c.slug === clientSlug)?.id ?? initialClient;
  const client = clients.find((c) => c.id === clientId) ?? null;
  const [ideas, setIdeas] = useState<Idea[] | null>(null);
  const [kind, setKind] = useState<EmailKind>("batch");
  const [idea, setIdea] = useState("");
  const [suggestionId, setSuggestionId] = useState<string | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [texts, setTexts] = useState(false);
  const [dueOn, setDueOn] = useState("");
  const [priority, setPriority] = useState<EmailPriority>("normal");
  const [draft, setDraft] = useState<BriefDraft | null>(null);
  const [busy, setBusy] = useState<"brief" | "create" | null>(null);

  useEffect(() => {
    if (!clientId) return;
    let live = true;
    suggestionsFor(clientId).then((x) => live && setIdeas(x));
    return () => {
      live = false;
    };
  }, [clientId]);

  const pick = (i: Idea) => {
    setKind(i.kind);
    setIdea(`${i.title}: ${i.idea}${i.why ? `\nWhy: ${i.why}` : ""}${i.subjects.length ? `\nSubject ideas: ${i.subjects.join(" / ")}` : ""}`);
    setSuggestionId(i.id);
    setTexts(/text/i.test(i.title));
    if (i.sendOn) setDueOn(i.sendOn);
    setDraft(null);
  };
  const write = async () => {
    if (!clientId) return;
    setBusy("brief");
    const r = await writeEmailBrief({ clientId, kind, idea, count, dueOn: dueOn || null, texts });
    setBusy(null);
    if (!r.ok) return toast({ tone: "bad", title: "Couldn't write the brief", body: r.error });
    setDraft(r.draft);
  };
  const create = async () => {
    if (!clientId || !draft) return;
    setBusy("create");
    const r = await createEmailTicket({ clientId, draft, priority, dueOn: dueOn || null, suggestionId });
    setBusy(null);
    if (!r.ok) return toast({ tone: "bad", title: "Couldn't make the ticket", body: r.error });
    toast({ tone: "ok", title: "On the Email Board", body: "The AI is writing the copy now." });
    router.push(`/board/email?t=${r.number}`);
  };

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div>
        <Link href="/board/email" className="inline-flex min-h-11 items-center text-sm text-muted hover:text-fg">
          ← Email Board
        </Link>
        <h1 className="font-heading text-3xl">New email request</h1>
        <p className="mt-1 text-sm text-muted">A campaign batch (up to {MAX_MESSAGES.batch} sends) or a flow (up to {MAX_MESSAGES.flow} messages). The AI writes the brief, then the copy as soon as it&apos;s on the board.</p>
      </div>

      <Combobox
        label="Client"
        className="w-full [&>button]:h-12"
        placeholder="Pick the client"
        value={client?.slug ?? null}
        onChange={(v) => {
          (client ? pushParams : replaceParams)({ client: v });
          setIdeas(null);
          setDraft(null);
          setSuggestionId(null);
        }}
        options={clients.map((c) => ({ value: c.slug, label: c.name, dot: tintFor(c.name) }))}
      />

      {client && (
        <section className="grid gap-3">
          <h2 className="text-sm font-medium">Start from a suggestion</h2>
          {!ideas ? (
            <p className="text-sm text-muted">Reading what worked…</p>
          ) : (
            <div className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 md:mx-0 md:grid md:grid-cols-2 md:px-0">
              {ideas.map((i, k) => (
                <button key={`${i.source}-${k}`} type="button" onClick={() => pick(i)} className={`grid w-[78vw] shrink-0 snap-start content-start gap-1.5 rounded-[16px] border p-4 text-left transition md:w-auto ${suggestionId && suggestionId === i.id ? "border-brand-text bg-brand-soft/40" : "border-line bg-surface hover:border-faint"}`}>
                  <span className="flex items-center justify-between gap-2 text-[11px] text-faint">
                    <span className="font-semibold uppercase tracking-[0.12em]">{SOURCE[i.source]}</span>
                    <span>{KIND_LABEL[i.kind]}</span>
                  </span>
                  <span className="font-medium leading-snug">{i.title}</span>
                  <span className="line-clamp-3 text-sm text-muted">{i.idea}</span>
                  {i.sendOn && <span className="text-xs text-faint">Send around {new Date(`${i.sendOn}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {client && (
        <section className="grid gap-4 rounded-[20px] border border-line bg-surface/40 p-4">
          <div className="flex rounded-full bg-ink/[0.06] p-1 text-sm" role="radiogroup" aria-label="Kind">
            {(["batch", "flow"] as const).map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => (setKind(k), setDraft(null))} className={`h-10 flex-1 rounded-full ${kind === k ? "bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.12)]" : "text-muted"}`}>
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
          <label className="grid gap-1 text-xs text-muted">
            What it&apos;s for
            <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={4} placeholder={kind === "flow" ? "A welcome series for new subscribers, leaning on the best sellers" : "Three sends for the holiday sale: announce, reminder, last chance"} className={field} />
          </label>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="grid gap-1 text-xs text-muted">
              Messages
              <select value={count ?? ""} onChange={(e) => setCount(e.target.value ? Number(e.target.value) : null)} className={`${field} h-11`}>
                <option value="">AI decides</option>
                {Array.from({ length: MAX_MESSAGES[kind] }).map((_, i) => (
                  <option key={i} value={i + 1}>
                    {i + 1}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-xs text-muted">
              Send or live by
              <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} className={`${field} h-11`} />
            </label>
            <label className="grid gap-1 text-xs text-muted">
              Priority
              <select value={priority} onChange={(e) => setPriority(e.target.value as EmailPriority)} className={`${field} h-11`}>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-2 self-end text-sm">
              <input type="checkbox" checked={texts} onChange={(e) => setTexts(e.target.checked)} className="h-5 w-5" />
              Include texts
            </label>
          </div>
          <button type="button" disabled={!idea.trim() || busy !== null} onClick={write} className="h-12 rounded-brand bg-fg text-sm font-medium text-bg disabled:opacity-40">
            {busy === "brief" ? "Writing the brief…" : draft ? "Write it again" : "Write the brief"}
          </button>
        </section>
      )}

      {draft && (
        <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-4">
          <label className="grid gap-1 text-xs text-muted">
            Title
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} className={field} />
          </label>
          {draft.kind === "flow" && (
            <label className="grid gap-1 text-xs text-muted">
              Trigger
              <input value={draft.trigger} onChange={(e) => setDraft({ ...draft, trigger: e.target.value })} className={field} />
            </label>
          )}
          <label className="grid gap-1 text-xs text-muted">
            Goal
            <input value={draft.goal} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} className={field} />
          </label>
          <label className="grid gap-1 text-xs text-muted">
            Brief
            <textarea value={draft.brief} onChange={(e) => setDraft({ ...draft, brief: e.target.value })} rows={8} className={`${field} leading-relaxed`} />
          </label>
          <div className="grid gap-2">
            <p className="text-xs text-muted">
              Messages ({draft.messages.length} of {MAX_MESSAGES[draft.kind]})
            </p>
            {draft.messages.map((m, i) => (
              <div key={i} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
                <select value={m.channel} onChange={(e) => setDraft({ ...draft, messages: draft.messages.map((x, k) => (k === i ? { ...x, channel: e.target.value as "email" | "sms" } : x)) })} aria-label="Email or text" className={`${field} h-11 w-24`}>
                  <option value="email">Email</option>
                  <option value="sms">Text</option>
                </select>
                <input value={m.name} onChange={(e) => setDraft({ ...draft, messages: draft.messages.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} aria-label="Name" className={`${field} h-11`} />
                {draft.kind === "batch" ? (
                  <input type="date" value={m.sendOn ?? ""} onChange={(e) => setDraft({ ...draft, messages: draft.messages.map((x, k) => (k === i ? { ...x, sendOn: e.target.value || null } : x)) })} aria-label="Send day" className={`${field} h-11 w-40`} />
                ) : (
                  <span className="flex items-center gap-1 text-xs text-muted">
                    wait
                    <input type="number" min={0} value={m.delayHours ?? 0} onChange={(e) => setDraft({ ...draft, messages: draft.messages.map((x, k) => (k === i ? { ...x, delayHours: Number(e.target.value) } : x)) })} aria-label="Hours to wait" className={`${field} h-11 w-20`} />h
                  </span>
                )}
              </div>
            ))}
            <div className="flex gap-2">
              {draft.messages.length < MAX_MESSAGES[draft.kind] && (
                <button type="button" onClick={() => setDraft({ ...draft, messages: [...draft.messages, { channel: "email", name: `${draft.kind === "flow" ? "Message" : "Email"} ${draft.messages.length + 1}`, sendOn: null, delayHours: draft.kind === "flow" ? 24 : null }] })} className="h-11 rounded-brand border border-dashed border-line px-4 text-sm text-muted hover:text-fg">
                  + Add one
                </button>
              )}
              {draft.messages.length > 1 && (
                <button type="button" onClick={() => setDraft({ ...draft, messages: draft.messages.slice(0, -1) })} className="h-11 rounded-brand px-3 text-sm text-faint hover:text-bad">
                  Remove the last
                </button>
              )}
            </div>
          </div>
          <button type="button" disabled={busy !== null || !draft.title.trim()} onClick={create} className="h-12 rounded-brand bg-brand text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.6)] hover:bg-brand-hover disabled:opacity-40">
            {busy === "create" ? "Putting it on the board…" : "Put it on the Email Board"}
          </button>
        </section>
      )}
    </div>
  );
}
