"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { assignLoomVideo, attributeBuyerInsights, consolidateBuyerInsights, importLooms, keepLoomsGoing, recheckLoomFolder, retryLoomVideo, ruleBuyerInsight } from "@/app/(team)/loom-actions";
import type { InsightsStatus } from "@/lib/buying-insights";
import type { LoomStatus } from "@/lib/loom-intake";
import { loomFolders, pastedLooms } from "@/lib/loom-links";

// Loom videos into the agents' knowledge: what's synced and where it went, the queue's progress, the videos waiting
// for someone to pick their client, the ones Loom wouldn't show (with what to change in Loom), and a box to paste many
// links or a shared folder link at once. In Settings (every video) and on a client's Documents (that client's).

const SOURCE: Record<string, string> = { slack: "Slack", webhook: "Zapier / email", bulk: "Pasted", client: "Client page", folder: "Shared folder" };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never");

export function LoomPanel({ status, clients = [], clientId = null }: { status: LoomStatus; clients?: { id: string; name: string }[]; clientId?: string | null }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const active = status.queued + status.reading;
  const settled = status.filed + status.skipped + status.failed + status.review;
  const pct = status.total ? Math.round((settled / status.total) * 100) : 0;

  // While videos are waiting: nudge the queue and follow it
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => {
      void keepLoomsGoing().then(() => router.refresh());
    }, 8000);
    return () => clearInterval(t);
  }, [active, router]);

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
    <section className="grid gap-5 rounded-[22px] border border-line bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="font-heading text-[20px] leading-tight">Loom videos</h2>
          <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted">
            {clientId
              ? "Looms about this client, from their Slack channels, a shared folder or pasted here. The situation goes into their knowledge and its decisions into memory (dated); buying lessons go to the Media Buyer."
              : "Every Loom posted in Slack, sent by Zapier or an email rule, pasted here, or found in a shared folder is read and filed: buying method to the Media Buyer (and the Google auditor), client situations to that client, the rest skipped."}
          </p>
        </div>
        {status.total > 0 && <span className="tabular text-[12px] text-faint">{status.total} videos</span>}
      </div>

      {status.total > 0 && (
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Filed" value={status.filed} tone="ok" />
            <Stat label="In the queue" value={active} tone={active ? "brand" : undefined} />
            <Stat label="Waiting for a client" value={status.review} tone={status.review ? "warn" : undefined} />
            <Stat label="Couldn't read" value={status.failed} tone={status.failed ? "bad" : undefined} />
          </div>
          {active > 0 && (
            <div className="grid gap-1">
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
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
            {!clientId && (
              <>
                <span>Media Buyer {status.toMediaBuyer}</span>
                <span>Google auditor {status.toGoogle}</span>
                <span>Clients {status.toClients}</span>
              </>
            )}
            <span>Skipped (not ads or a client) {status.skipped}</span>
            {Object.entries(status.bySource)
              .filter(([, n]) => n)
              .map(([k, n]) => (
                <span key={k}>
                  {SOURCE[k] ?? k} {n}
                </span>
              ))}
          </div>
        </div>
      )}

      <div className="grid gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={"Paste Loom links, one per line (hundreds at once is fine), a CSV export of links, or a shared folder link:\nhttps://www.loom.com/share/…\nhttps://www.loom.com/share/folder/…"}
          className="min-h-[112px] w-full resize-y rounded-[14px] border border-line bg-bg px-3 py-2.5 text-[14px] leading-relaxed placeholder:text-faint focus:border-brand focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" disabled={busy || !text.trim()} onClick={() => void submit()} className="min-h-11 rounded-full bg-fg px-5 text-[14px] font-medium text-bg disabled:opacity-50 md:min-h-9">
            {busy ? "Adding…" : lines > 1 ? `Add ${lines} links` : "Add"}
          </button>
          <span className="text-[12px] text-faint">Duplicates are skipped. Each video needs sharing set to anyone with the link, and captions on.</span>
        </div>
        {note && <p className={`text-[12.5px] ${note.tone === "ok" ? "text-ok" : "text-bad"}`}>{note.text}</p>}
      </div>

      {status.folders.length > 0 && (
        <Group title="Shared folders" hint="Read again every day, so new recordings come in by themselves.">
          {status.folders.map((f) => (
            <FolderRow key={f.id} f={f} />
          ))}
        </Group>
      )}

      {status.waiting.length > 0 && (
        <Group title="Which client is this about?" hint="The AI couldn't tell for sure. Pick the client and it's filed to them.">
          {status.waiting.map((w) => (
            <ReviewRow key={w.id} w={w} clients={clients} clientId={clientId} />
          ))}
        </Group>
      )}

      {status.failures.length > 0 && (
        <Group title="Couldn't read" hint="Change it in Loom, then try again.">
          {status.failures.map((f) => (
            <FailRow key={f.id} f={f} />
          ))}
        </Group>
      )}
    </section>
  );
}

const LAYERS: { key: keyof InsightsStatus["byLayer"]; label: string }[] = [
  { key: "principle", label: "Principles" },
  { key: "rule", label: "Decision rules" },
  { key: "diagnostic", label: "Diagnostics" },
  { key: "case", label: "Cases" },
  { key: "voice", label: "Voice" },
];

/** What the Media Buyer has learned from the senior buyer's Looms: the layers, contradictions to rule on, Consolidate now */
export function BuyerInsightsPanel({ status, canRule }: { status: InsightsStatus; canRule: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const total = Object.values(status.byLayer).reduce((n, x) => n + x, 0);
  if (!total && !status.waiting) return null;
  return (
    <section className="grid gap-4 rounded-[22px] border border-line bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="font-heading text-[20px] leading-tight">How the senior buyer buys</h2>
          <p className="max-w-2xl text-[13.5px] leading-relaxed text-muted">
            Distilled from his Loom audits, each point quoting its moment. Points said in several videos merge and count up; the best supported become the Media Buyer&rsquo;s generated skills (auditor, launcher, fatigue, and the Google auditor for Google). The hand-written skills are never changed.
          </p>
        </div>
        {canRule && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setNote(null);
              const r = await consolidateBuyerInsights();
              setBusy(false);
              setNote(r.ok ? `${r.merged} merged, ${r.kept} new points, ${r.conflicts} to rule on${r.left ? `, ${r.left} still to go` : ""}.` : r.error);
              router.refresh();
            }}
            className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9"
          >
            {busy ? "Consolidating…" : "Consolidate now"}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {LAYERS.map((l) => (
          <Stat key={l.key} label={l.label} value={status.byLayer[l.key]} />
        ))}
      </div>
      <p className="text-[12px] text-faint">
        {status.waiting ? `${status.waiting} new points waiting to be merged · ` : ""}Skills rewritten {when(status.skillsAt)}
      </p>
      {note && <p className="text-[12.5px] text-muted">{note}</p>}
      <Attribution a={status.attribution} canRun={canRule} />
      {status.top.length > 0 && (
        <ul className="grid gap-1.5 text-[13px]">
          {status.top.map((t, i) => (
            <li key={i} className="flex gap-2">
              <span className="tabular shrink-0 text-faint">{t.confidence}×</span>
              <span className="leading-relaxed">{t.body}</span>
            </li>
          ))}
        </ul>
      )}
      {status.conflicts.length > 0 && (
        <Group title="Contradictions to rule on" hint="Two of his videos (or a video and a written skill) disagree. Your call decides what the agents are taught.">
          {status.conflicts.map((c) => (
            <ConflictRow key={c.id} c={c} canRule={canRule} />
          ))}
        </Group>
      )}
    </section>
  );
}

/** Where the points came from: general (every account's skills) or only for one kind of business, by vertical and platform */
function Attribution({ a, canRun }: { a: InsightsStatus["attribution"]; canRun: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="grid gap-3 rounded-[16px] border border-line bg-bg/40 p-3 md:p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid gap-0.5">
          <h3 className="text-[14px] font-medium">By platform and industry</h3>
          <p className="max-w-2xl text-[12.5px] leading-relaxed text-muted">
            General points are taught to every account&rsquo;s buyer. Industry points only come with accounts in that sub-vertical, its vertical or the same business model, on their platform.
          </p>
        </div>
        {canRun && (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setNote(null);
              const r = await attributeBuyerInsights();
              setBusy(false);
              setNote(r.ok ? `${r.attributed} attributed, ${r.scoped} sorted (${r.industry} industry-only), ${r.platform} given a platform${r.left ? `, ${r.left} still to go` : ""}.` : r.error);
              router.refresh();
            }}
            className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9"
          >
            {busy ? "Attributing…" : a.pending ? `Attribute ${a.pending} now` : "Attribute again"}
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="General" value={a.general} />
        <Stat label="Industry only" value={a.industry} tone="brand" />
        <Stat label="No industry found" value={a.unmapped} tone={a.unmapped ? "warn" : undefined} />
        <Stat label="Still to sort" value={a.pending} tone={a.pending ? "warn" : "ok"} />
      </div>
      {note && <p className="text-[12.5px] text-muted">{note}</p>}
      {a.verticals.length > 0 && (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[420px] text-[12.5px]">
            <thead className="text-left text-faint">
              <tr>
                <th className="px-1 py-1 font-normal">Vertical</th>
                <th className="px-1 py-1 text-right font-normal">Meta</th>
                <th className="px-1 py-1 text-right font-normal">Google</th>
                <th className="px-1 py-1 text-right font-normal">Both</th>
                <th className="px-1 py-1 text-right font-normal">None</th>
                <th className="px-1 py-1 text-right font-normal">Industry only</th>
              </tr>
            </thead>
            <tbody>
              {a.verticals.map((v) => (
                <tr key={v.name} className="border-t border-line">
                  <td className="px-1 py-1.5">{v.name}</td>
                  <td className="tabular px-1 py-1.5 text-right">{v.meta}</td>
                  <td className="tabular px-1 py-1.5 text-right">{v.google}</td>
                  <td className="tabular px-1 py-1.5 text-right">{v.both}</td>
                  <td className="tabular px-1 py-1.5 text-right text-muted">{v.none}</td>
                  <td className="tabular px-1 py-1.5 text-right text-brand-text">{v.industry}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ConflictRow({ c, canRule }: { c: InsightsStatus["conflicts"][number]; canRule: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const rule = async (r: "keep" | "drop" | "both") => {
    setBusy(true);
    const res = await ruleBuyerInsight(c.id, r);
    setBusy(false);
    if (!res.ok) alert(res.error);
    router.refresh();
  };
  return (
    <li className="grid gap-2 rounded-[14px] border border-line bg-bg/40 p-3">
      <p className="text-[13.5px] leading-relaxed">{c.body}</p>
      {c.quote && (
        <p className="text-[12.5px] italic text-muted">
          &ldquo;{c.quote}&rdquo;{" "}
          {c.url && (
            <a href={c.url} target="_blank" rel="noreferrer" className="not-italic text-brand-text hover:underline">
              {c.at ? `at ${c.at}` : "watch"}
            </a>
          )}
        </p>
      )}
      <p className="text-[12.5px] text-warn">
        Disagrees with {c.againstSkill ? `the written skill "${c.againstSkill}"` : `"${(c.against ?? "another point").slice(0, 220)}"`}
        {c.note ? `: ${c.note}` : ""}
      </p>
      {canRule && (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void rule("keep")} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:min-h-9">
            Teach this one
          </button>
          <button type="button" disabled={busy} onClick={() => void rule("both")} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9">
            Both hold (different situations)
          </button>
          <button type="button" disabled={busy} onClick={() => void rule("drop")} className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-bad disabled:opacity-50 md:min-h-9">
            Don&rsquo;t teach it
          </button>
        </div>
      )}
    </li>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" | "bad" | "brand" }) {
  const color = tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : tone === "brand" ? "text-brand-text" : "text-fg";
  return (
    <div className="grid gap-0.5 rounded-[14px] border border-line bg-bg/40 px-3 py-2.5">
      <span className={`tabular font-heading text-[22px] leading-none ${color}`}>{value}</span>
      <span className="text-[12px] text-muted">{label}</span>
    </div>
  );
}

function Group({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-2">
      <div className="grid gap-0.5">
        <h3 className="text-[14px] font-medium">{title}</h3>
        <p className="text-[12px] text-faint">{hint}</p>
      </div>
      <ul className="grid gap-2">{children}</ul>
    </div>
  );
}

function FolderRow({ f }: { f: LoomStatus["folders"][number] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <li className="grid gap-1.5 rounded-[14px] border border-line bg-bg/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-[14px] font-medium hover:underline">
          {f.name ?? "Loom folder"}
        </a>
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
          className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9"
        >
          {busy ? "Reading…" : "Check now"}
        </button>
      </div>
      <span className="text-[12px] text-faint">
        {f.videos} videos{f.client ? ` · ${f.client}` : ""} · checked {when(f.checked)}
      </span>
      {f.error && <p className="text-[12px] text-bad">{f.error}</p>}
    </li>
  );
}

function ReviewRow({ w, clients, clientId }: { w: LoomStatus["waiting"][number]; clients: { id: string; name: string }[]; clientId: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const pick = async (v: string) => {
    if (!v) return;
    setBusy(true);
    const r = await assignLoomVideo(w.id, v === "none" ? null : v);
    setBusy(false);
    if (!r.ok) alert(r.error);
    router.refresh();
  };
  // Guesses first, then everyone (on a client page: this client, or not them)
  const guessed = clients.filter((c) => w.guesses.includes(c.name));
  return (
    <li className="grid gap-2 rounded-[14px] border border-line bg-bg/40 p-3">
      <a href={w.url} target="_blank" rel="noreferrer" className="text-[14px] font-medium hover:underline">
        {w.title}
      </a>
      {w.summary && <p className="line-clamp-3 text-[12.5px] leading-relaxed text-muted">{w.summary}</p>}
      {clientId ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void pick(clientId)} className="min-h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:min-h-9">
            It&rsquo;s about this client
          </button>
        </div>
      ) : (
        <select
          defaultValue=""
          disabled={busy}
          onChange={(e) => void pick(e.target.value)}
          className="min-h-11 w-full rounded-[12px] border border-line bg-bg px-3 text-[14px] disabled:opacity-50 sm:w-auto sm:min-w-[260px] md:min-h-9"
          aria-label="Client"
        >
          <option value="" disabled>
            {busy ? "Filing…" : "Pick the client"}
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
          <option value="none">Not about one client</option>
        </select>
      )}
    </li>
  );
}

function FailRow({ f }: { f: LoomStatus["failures"][number] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <li className="grid gap-1.5 rounded-[14px] border border-line bg-bg/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <a href={f.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-[14px] font-medium hover:underline">
          {f.title}
        </a>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await retryLoomVideo(f.id);
            setBusy(false);
            if (!r.ok) alert(r.error);
            router.refresh();
          }}
          className="min-h-11 rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-9"
        >
          {busy ? "Queued…" : "Try again"}
        </button>
      </div>
      <p className="text-[12px] leading-relaxed text-bad">{f.error}</p>
      <span className="text-[11.5px] text-faint">From {SOURCE[f.source] ?? f.source}</span>
    </li>
  );
}
