"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { assignLoomVideo, importLooms, keepLoomsGoing, prospectBecameClient, recheckLoomFolder, retryLoomVideo, saveLoomProspect, teachLoomVideo } from "@/app/(team)/loom-actions";
import type { LoomStatus, LoomTab, LoomVideo } from "@/lib/loom-intake";
import { loomFolders, pastedLooms } from "@/lib/loom-links";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";

// Loom videos into the agents' knowledge, as a library: one tab for each place a video goes (filed to a client,
// teaching the buyers, waiting for a decision, pre-sale audits of prospects, skipped, couldn't be read), each video a
// tidy row with its picture, date, platform, where it went and a Watch link. Adding links and the shared folders sit
// behind their own buttons. In Settings (every video) and on a client's Documents (theirs).

type Client = { id: string; name: string };

const TAB_LABEL: Record<Exclude<LoomTab, "queue">, string> = {
  decide: "Needs a decision",
  clients: "Filed to a client",
  method: "Teaching the buyer",
  prospects: "Prospects",
  skipped: "Skipped",
  failed: "Failed",
};
const CLIENT_LABEL: Partial<Record<LoomTab, string>> = { clients: "Filed here", prospects: "Pre-sale audits" };
const ORDER: Exclude<LoomTab, "queue">[] = ["decide", "method", "clients", "prospects", "skipped", "failed"];
const SOURCE: Record<string, string> = { slack: "Slack", webhook: "Zapier", bulk: "Pasted", client: "Client page", folder: "Folder", atlassian: "Atlassian" };
const PLATFORM: Record<string, string> = { meta: "Meta", google: "Google", both: "Meta + Google" };
const AGENT: Record<string, string> = { "role:media_buyer": "Media Buyer", google_auditor: "Google Ads Buyer" };
const PAGE = 25;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");

export function LoomPanel({ status, clients = [], clientId = null, canDecide = true }: { status: LoomStatus; clients?: Client[]; clientId?: string | null; canDecide?: boolean }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  // Rows decided here leave their tab at once; the refresh brings them back where they now belong
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const active = status.queued + status.reading;
  const raw = useParam("lt") as LoomTab | null;
  const tabs = ORDER.filter((t) => status.counts[t] > 0 || t === "decide" || (!clientId && t === "method"));
  const tab: LoomTab = raw && tabs.includes(raw as Exclude<LoomTab, "queue">) ? raw : status.counts.decide ? "decide" : clientId ? (status.counts.prospects ? "prospects" : "clients") : "method";
  const list = useMemo(() => status.videos.filter((v) => v.tabs.includes(tab) && !gone.has(v.id)), [status.videos, tab, gone]);
  const settled = status.total - active;
  const pct = status.total ? Math.round((settled / status.total) * 100) : 0;

  // While videos are waiting: nudge the queue and follow it
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void keepLoomsGoing().then(() => router.refresh()), 8000);
    return () => clearInterval(t);
  }, [active, router]);

  const hide = (id: string) => setGone((g) => new Set(g).add(id));
  const unhide = (id: string) =>
    setGone((g) => {
      const n = new Set(g);
      n.delete(id);
      return n;
    });

  return (
    <section className="grid min-w-0 gap-5 rounded-[24px] border border-line bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-0.5">
          <h2 className="font-heading text-[20px] leading-tight">Loom videos</h2>
          <p className="text-[13px] text-muted">{clientId ? "Looms about this client, and the senior buyer's audits from before they signed." : "Every Loom from Slack, Zapier, a shared folder or pasted here, read and sorted."}</p>
          {!clientId && (
            <p className="flex items-center gap-1.5 text-[12px] text-faint">
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${status.auto ? "bg-ok" : "bg-faint"}`} aria-hidden />
              {status.auto ? (
                "New Looms come in automatically through Atlassian."
              ) : (
                <span>
                  Connect Loom through Atlassian and new Looms come in automatically.{" "}
                  <Link href="/settings?tab=connections" className="text-brand-text hover:underline">
                    Connections
                  </Link>
                </span>
              )}
            </p>
          )}
        </div>
        <button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding} className={`min-h-11 rounded-full px-4 text-[13px] font-medium md:min-h-9 ${adding ? "bg-surface-2 text-fg" : "bg-fg text-bg"}`}>
          {adding ? "Done adding" : "Add Looms"}
        </button>
      </div>

      {active > 0 && (
        <div className="grid gap-1.5">
          <div className="flex justify-between text-[12px] text-muted">
            <span>{status.reading ? `Reading ${status.reading} now` : "Waiting for the next run"}</span>
            <span className="tabular">
              {settled} of {status.total}
            </span>
          </div>
          <span className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <span className="block h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${Math.max(3, pct)}%` }} />
          </span>
        </div>
      )}

      {adding && <AddLooms clientId={clientId} folders={status.folders} />}

      {clientId && status.presale > 0 && (
        <button type="button" onClick={() => pushParams({ lt: "prospects" })} className="grid gap-1 rounded-[16px] border border-brand/30 bg-brand-soft/50 p-3.5 text-left">
          <span className="text-[13.5px] font-medium">
            {status.presale} pre-sale audit Loom{status.presale === 1 ? "" : "s"} attached
          </span>
          <span className="text-[12.5px] leading-relaxed text-muted">The senior buyer audited their account before they signed. It&apos;s in their knowledge and memory, and their go-to-market strategy starts from it.</span>
        </button>
      )}

      {status.total > 0 && (
        <>
          <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
            <div className="flex w-max gap-1.5" role="tablist" aria-label="Loom videos">
              {tabs.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tab === t}
                  onClick={() => {
                    setShown(PAGE);
                    replaceParams({ lt: t });
                  }}
                  className={`inline-flex min-h-11 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors md:min-h-9 ${tab === t ? "border-fg bg-fg text-bg" : "border-line text-muted hover:text-fg"}`}
                >
                  {(clientId && CLIENT_LABEL[t]) || TAB_LABEL[t]}
                  <span className={`tabular text-[11.5px] ${tab === t ? "opacity-70" : t === "decide" && status.counts.decide ? "text-warn" : "text-faint"}`}>{status.counts[t]}</span>
                </button>
              ))}
            </div>
          </div>

          {list.length === 0 ? (
            <p className="rounded-[16px] border border-dashed border-line px-4 py-8 text-center text-[13px] text-faint">{tab === "decide" ? "Nothing waiting. Every Loom has a home." : "No videos here yet."}</p>
          ) : (
            <ul className="grid gap-2">
              {list.slice(0, shown).map((v) => (
                <VideoRow key={v.id} v={v} tab={tab} clients={clients} clientId={clientId} canDecide={canDecide} onDone={hide} onUndo={unhide} />
              ))}
            </ul>
          )}
          {list.length > shown && (
            <button type="button" onClick={() => setShown((s) => s + PAGE * 2)} className="min-h-11 justify-self-center rounded-full border border-line px-5 text-[13px] text-muted hover:text-fg md:min-h-9">
              Show more ({list.length - shown})
            </button>
          )}
        </>
      )}
    </section>
  );
}

// ─── Adding links and folders ───────────────────────────────────────────────

function AddLooms({ clientId, folders }: { clientId: string | null; folders: LoomStatus["folders"] }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const lines = pastedLooms(text).length + loomFolders(text).length;
  const submit = async () => {
    setBusy(true);
    setNote(null);
    const r = await importLooms(text, clientId);
    setBusy(false);
    if (!r.ok) return setNote({ tone: "bad", text: r.error });
    const folderBits = r.folders.map((f) => (f.error ? f.error : `Folder: ${f.found} videos found, ${f.added} new.`));
    setNote({ tone: r.folders.some((f) => f.error) ? "bad" : "ok", text: [`${r.added} added to the queue${r.skipped ? `, ${r.skipped} already in` : ""}.`, ...folderBits].join(" ") });
    setText("");
    router.refresh();
  };
  return (
    <div className="grid gap-3 rounded-[18px] border border-line bg-bg/50 p-3 md:p-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder={"Paste Loom links, one per line (hundreds at once is fine), a CSV export, or a shared folder link:\nhttps://www.loom.com/share/…\nhttps://www.loom.com/share/folder/…"}
        className="min-h-[112px] w-full resize-y rounded-[14px] border border-line bg-surface px-3 py-2.5 text-[14px] leading-relaxed placeholder:text-faint focus:border-brand focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" disabled={busy || !text.trim()} onClick={() => void submit()} className="min-h-11 rounded-full bg-fg px-5 text-[14px] font-medium text-bg disabled:opacity-50 md:min-h-9">
          {busy ? "Adding…" : lines > 1 ? `Add ${lines} links` : "Add"}
        </button>
        <span className="text-[12px] text-faint">Duplicates are skipped. Sharing set to anyone with the link, captions on.</span>
      </div>
      {note && <p className={`text-[12.5px] ${note.tone === "ok" ? "text-ok" : "text-bad"}`}>{note.text}</p>}
      {folders.length > 0 && (
        <details className="group">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-[13px] text-muted hover:text-fg md:min-h-8">
            <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
            Shared folders ({folders.length}), read again every day
          </summary>
          <ul className="mt-2 grid gap-2">
            {folders.map((f) => (
              <FolderRow key={f.id} f={f} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function FolderRow({ f }: { f: LoomStatus["folders"][number] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-[14px] border border-line bg-surface px-3 py-2">
      <div className="grid min-w-0 gap-0.5">
        <a href={f.url} target="_blank" rel="noreferrer" className="truncate text-[13.5px] font-medium hover:underline">
          {f.name ?? "Loom folder"}
        </a>
        <span className="text-[11.5px] text-faint">
          {f.videos} videos{f.client ? ` · ${f.client}` : ""} · checked {when(f.checked)}
        </span>
        {f.error && <span className="text-[11.5px] text-bad">{f.error}</span>}
      </div>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await recheckLoomFolder(f.id);
          setBusy(false);
          if (!r.ok) alert(r.error);
          router.refresh();
        }}
        className="min-h-11 rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg disabled:opacity-50 md:min-h-8"
      >
        {busy ? "Reading…" : "Check now"}
      </button>
    </li>
  );
}

// ─── One video ──────────────────────────────────────────────────────────────

/** Loom's picture, or a drawn tile when Loom has none (private videos, a CDN miss): never a broken image */
function Thumb({ src, title }: { src: string | null; title: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="relative grid aspect-video w-[104px] shrink-0 place-items-center overflow-hidden rounded-[10px] border border-line bg-gradient-to-br from-brand-soft to-surface-2 sm:w-[132px]">
      {src && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 h-full w-full object-cover" />
      ) : (
        <span aria-hidden className="px-2 text-center font-heading text-[11px] leading-tight text-muted line-clamp-2">
          {title}
        </span>
      )}
      <span aria-hidden className="absolute bottom-1.5 left-1.5 grid h-6 w-6 place-items-center rounded-full bg-bg/80 text-fg backdrop-blur-sm">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
          <path d="M7 4v16l13-8z" />
        </svg>
      </span>
    </span>
  );
}

function Chip({ children, tone = "plain", href }: { children: React.ReactNode; tone?: "plain" | "brand" | "ok" | "warn"; href?: string }) {
  const cls = `inline-flex max-w-full items-center truncate rounded-full px-2 py-0.5 text-[11px] ${tone === "brand" ? "bg-brand-soft text-brand-text" : tone === "ok" ? "bg-ok-soft text-ok" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-surface-2 text-muted"}`;
  return href ? (
    <Link href={href} className={`${cls} hover:underline`}>
      {children}
    </Link>
  ) : (
    <span className={cls}>{children}</span>
  );
}

function VideoRow({ v, tab, clients, clientId, canDecide, onDone, onUndo }: { v: LoomVideo; tab: LoomTab; clients: Client[]; clientId: string | null; canDecide: boolean; onDone: (id: string) => void; onUndo: (id: string) => void }) {
  const p = v.prospect;
  return (
    <li className="grid gap-3 rounded-[18px] border border-line bg-bg/40 p-2.5 md:p-3">
      <div className="flex min-w-0 gap-3">
        <a href={v.url} target="_blank" rel="noreferrer" aria-label={`Watch ${v.title}`}>
          <Thumb src={v.thumb} title={v.title} />
        </a>
        <div className="grid min-w-0 flex-1 content-start gap-1.5">
          <div className="flex min-w-0 items-start justify-between gap-2">
            <a href={v.url} target="_blank" rel="noreferrer" className="line-clamp-2 text-[14px] font-medium leading-snug hover:underline">
              {v.title}
            </a>
            <a href={v.url} target="_blank" rel="noreferrer" className="hidden shrink-0 rounded-full border border-line px-3 py-1 text-[12px] text-muted hover:text-fg sm:inline-flex">
              Watch
            </a>
          </div>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-faint">
            <span className="tabular">{day(v.date)}</span>
            {v.platform && PLATFORM[v.platform] && <Chip>{PLATFORM[v.platform]}</Chip>}
            {v.clients.map((c) => (
              <Chip key={c.id} tone="ok" href={`/clients/${c.slug}`}>
                {c.name}
              </Chip>
            ))}
            {v.agents.map((a) => (
              <Chip key={a} tone="brand">
                {AGENT[a] ?? a}
              </Chip>
            ))}
            {p && <Chip tone={p.status === "client" ? "ok" : "warn"}>{p.status === "client" ? `Pre-sale${p.client ? `: ${p.client.name}` : ""}` : `Prospect${p.name ? `: ${p.name}` : ""}`}</Chip>}
            <span>{SOURCE[v.source] ?? v.source}</span>
          </p>
          {v.summary && tab !== "failed" && <p className="line-clamp-2 text-[12.5px] leading-relaxed text-muted">{v.summary}</p>}
          {tab === "failed" && v.error && <p className="text-[12px] leading-relaxed text-bad">{v.error}</p>}
        </div>
      </div>
      {tab === "decide" && canDecide && <Decide v={v} clients={clients} clientId={clientId} onDone={onDone} onUndo={onUndo} />}
      {tab === "prospects" && p?.status === "prospect" && canDecide && <ProspectActions v={v} clients={clients} onDone={onDone} onUndo={onUndo} />}
      {tab === "failed" && <Retry id={v.id} onDone={onDone} onUndo={onUndo} />}
    </li>
  );
}

function Retry({ id, onDone, onUndo }: { id: string; onDone: (id: string) => void; onUndo: (id: string) => void }) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        onDone(id);
        const r = await retryLoomVideo(id);
        if (!r.ok) {
          onUndo(id);
          alert(r.error);
        }
        router.refresh();
      }}
      className="min-h-11 justify-self-start rounded-full border border-line px-4 text-[12.5px] text-muted hover:text-fg md:min-h-8"
    >
      Try again
    </button>
  );
}

/** Pick a client: likely ones first, then everyone (one dropdown, saves on change) */
function ClientSelect({ clients, guesses = [], placeholder, onPick, extra }: { clients: Client[]; guesses?: string[]; placeholder: string; onPick: (id: string) => void; extra?: React.ReactNode }) {
  const guessed = clients.filter((c) => guesses.includes(c.name));
  return (
    <select
      defaultValue=""
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="min-h-11 w-full rounded-[12px] border border-line bg-surface px-3 text-[14px] sm:w-auto sm:min-w-[240px] md:min-h-9 md:text-[13px]"
      aria-label={placeholder}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {guessed.length > 0 && (
        <optgroup label="Likely">
          {guessed.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Every client">
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </optgroup>
      {extra}
    </select>
  );
}

/** Needs a decision: it's about one of our clients (pick them), or it isn't (its strategy is taught, the prospect kept) */
function Decide({ v, clients, clientId, onDone, onUndo }: { v: LoomVideo; clients: Client[]; clientId: string | null; onDone: (id: string) => void; onUndo: (id: string) => void }) {
  const router = useRouter();
  const [teaching, setTeaching] = useState(false);
  const s = v.suggested;
  const pick = async (id: string) => {
    onDone(v.id);
    const r = await assignLoomVideo(v.id, id);
    if (!r.ok) {
      onUndo(v.id);
      alert(r.error);
    }
    router.refresh();
  };
  return (
    <div className="grid gap-2.5 border-t border-line/70 pt-2.5">
      {s?.is_prospect && !teaching && (
        <p className="text-[12px] text-muted">
          <span className="text-warn">Looks like a pre-sale audit</span>
          {s.name ? ` of ${s.name}` : ""}
          {s.business ? ` (${s.business})` : ""}.
        </p>
      )}
      {!teaching ? (
        <div className="flex flex-wrap items-center gap-2">
          {clientId ? (
            <button type="button" onClick={() => void pick(clientId)} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
              It&apos;s about this client
            </button>
          ) : (
            <ClientSelect clients={clients} guesses={v.guesses} placeholder="Attribute to client" onPick={(id) => void pick(id)} />
          )}
          <button type="button" onClick={() => setTeaching(true)} className={`min-h-11 rounded-full px-4 text-[13px] md:min-h-9 ${s?.is_prospect ? "bg-warn-soft font-medium text-warn" : "border border-line text-muted hover:text-fg"}`}>
            Not a client: use for skills
          </button>
        </div>
      ) : (
        <ProspectForm
          initial={{ name: s?.name ?? "", domain: s?.domain ?? "", adAccount: s?.ad_account ?? "", business: s?.business ?? "" }}
          cta="Use for skills and knowledge"
          hint={v.agents.length ? "Its strategy is already in the buyers' skills. The prospect is kept, so these Looms follow them if they sign." : "The senior buyer's strategy is distilled into the Meta and Google buying skills. The prospect is kept, so these Looms follow them if they sign."}
          onCancel={() => setTeaching(false)}
          onSave={async (pr) => {
            onDone(v.id);
            const r = await teachLoomVideo(v.id, pr.name.trim() ? pr : null);
            if (!r.ok) {
              onUndo(v.id);
              alert(r.error);
            }
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

type ProspectFields = { name: string; domain: string; adAccount: string; business: string };

function ProspectForm({ initial, cta, hint, onSave, onCancel }: { initial: ProspectFields; cta: string; hint: string; onSave: (p: ProspectFields) => void; onCancel: () => void }) {
  const [f, setF] = useState(initial);
  const input = "min-h-11 w-full rounded-[12px] border border-line bg-surface px-3 text-[14px] placeholder:text-faint focus:border-brand focus:outline-none md:min-h-9 md:text-[13px]";
  return (
    <form
      className="grid gap-2.5"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(f);
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Prospect's business (empty if none)" aria-label="Prospect's business" className={input} />
        <input value={f.business} onChange={(e) => setF({ ...f, business: e.target.value })} placeholder="What they sell (e.g. dumpster rental)" aria-label="What they sell" className={input} />
        <input value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="Website" aria-label="Website" className={input} />
        <input value={f.adAccount} onChange={(e) => setF({ ...f, adAccount: e.target.value })} placeholder="Ad account (name or ID)" aria-label="Ad account" className={input} />
      </div>
      <p className="text-[12px] leading-relaxed text-faint">{hint}</p>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
          {cta}
        </button>
        <button type="button" onClick={onCancel} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A prospect still waiting: they became a client (one dropdown, saves on change), or their details corrected */
function ProspectActions({ v, clients, onDone, onUndo }: { v: LoomVideo; clients: Client[]; onDone: (id: string) => void; onUndo: (id: string) => void }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const p = v.prospect!;
  if (editing)
    return (
      <div className="border-t border-line/70 pt-2.5">
        <ProspectForm
          initial={{ name: p.name ?? "", domain: p.domain ?? "", adAccount: p.adAccount ?? "", business: p.business ?? "" }}
          cta="Save"
          hint="Matched daily against new clients by name, website and ad account."
          onCancel={() => setEditing(false)}
          onSave={async (pr) => {
            setEditing(false);
            const r = await saveLoomProspect(v.id, pr);
            if (!r.ok) alert(r.error);
            router.refresh();
          }}
        />
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line/70 pt-2.5">
      {(p.business || p.domain) && <span className="w-full text-[12px] text-muted">{[p.business, p.domain, p.adAccount].filter(Boolean).join(" · ")}</span>}
      <ClientSelect
        clients={clients}
        placeholder="This prospect became…"
        onPick={async (id) => {
          onDone(v.id);
          const r = await prospectBecameClient(v.id, id);
          if (!r.ok) {
            onUndo(v.id);
            alert(r.error);
          }
          router.refresh();
        }}
      />
      <button type="button" onClick={() => setEditing(true)} className="min-h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg md:min-h-9">
        Edit details
      </button>
    </div>
  );
}
