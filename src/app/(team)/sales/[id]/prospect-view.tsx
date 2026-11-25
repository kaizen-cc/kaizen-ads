"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { CallReview, PitchDrafts, ProspectBrief, ProspectStatus } from "@/lib/sales-core";
import { CallButton } from "@/components/call-button";
import { pushParams, useParam } from "@/lib/url-state";
import { deleteNoteAction, pitchAction, researchAction, reviewAction, updateAction, wonAction } from "../actions";
import { ArchiveButton, FitBadge, StageSelect, UnarchiveButton } from "../sales-view";

// One prospect: its research brief and Kaizen strategy, the outreach drafts and call reviews, and its stage, owner and
// notes. Tabs live in the address (?tab=), so back returns to the one you were on. Drafts are copied and sent by the
// person themselves (LinkedIn included: nothing is automated there).

export type ProspectNote =
  | { id: string; kind: "pitch"; title: string; at: string; pitch: PitchDrafts }
  | { id: string; kind: "call_review"; title: string; at: string; review: CallReview };

type P = { id: string; name: string; website: string | null; industry: string | null; location: string | null; status: ProspectStatus; fit: number | null; fitReason: string | null; ownerId: string | null; notes: string | null; lostReason: string | null; researchedAt: string | null; source: string | null; archived?: { at: string; by: string | null; label: string } | null };

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const host = (url: string) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");
const field = "w-full min-w-0 rounded-[14px] border border-line bg-bg px-3.5 text-[16px] text-fg placeholder:text-faint md:text-[14px]";

function Spinner() {
  return <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden />;
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        });
      }}
      className="inline-flex h-11 shrink-0 items-center rounded-full border border-line px-4 text-[13px] text-fg hover:bg-surface-2 md:h-8 md:px-3 md:text-[12px]"
    >
      {done ? "Copied" : label}
    </button>
  );
}

function Block({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="grid min-w-0 gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const Bullets = ({ items }: { items: string[] }) => (
  <ul className="grid gap-2">
    {items.map((x, i) => (
      <li key={i} className="flex min-w-0 gap-2.5 text-[14px] leading-relaxed text-fg">
        <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />
        <span className="min-w-0 break-words">{x}</span>
      </li>
    ))}
  </ul>
);

export function ProspectView({ p, brief, notes, people, docs, client, meId, calls = [], gtmSlot = null }: { p: P; brief: ProspectBrief | null; notes: ProspectNote[]; people: { id: string; name: string }[]; docs: { id: string; title: string; link: string | null; folder: string | null }[]; client: { name: string; slug: string } | null; meId: string; calls?: { id: string; title: string; startsAt: string; status: string }[]; gtmSlot?: React.ReactNode }) {
  const tab = useParam("tab") ?? "brief";
  const drafts = notes.length;
  return (
    <div className="mx-auto grid w-full min-w-0 max-w-[980px] gap-6 pb-12">
      <Link href="/sales" className="inline-flex min-h-11 w-fit items-center gap-1.5 text-[13px] text-muted hover:text-fg md:min-h-0">
        <span aria-hidden>←</span> Prospects
      </Link>
      <header className="grid min-w-0 gap-3">
        <div className="flex min-w-0 flex-wrap items-start gap-3">
          <div className="grid min-w-0 flex-1 gap-1">
            <h1 className="break-words font-heading text-[28px] leading-tight md:text-[34px]">{p.name}</h1>
            <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px] text-muted">
              {p.website && (
                <a href={p.website} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center break-all text-brand-text hover:underline md:min-h-0">
                  {host(p.website)} ↗
                </a>
              )}
              {[p.industry, p.location].filter(Boolean).length > 0 && <span className="break-words">{[p.industry, p.location].filter(Boolean).join(" · ")}</span>}
            </p>
          </div>
          <FitBadge fit={brief?.fit_score ?? p.fit} large />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <StageSelect key={p.status} id={p.id} status={p.status} />
          <OwnerSelect id={p.id} ownerId={p.ownerId} people={people} meId={meId} />
          {p.status !== "won" && !p.archived && <WonButton id={p.id} />}
          <CallButton roleKey="sales" context={{ screen: "a prospect's page", client: p.name, prospectId: p.id }} label="Talk to the Sales agent" className="justify-center border-brand/40 text-fg" />
        </div>
        {p.archived ? (
          <div className="grid gap-2 rounded-[14px] bg-surface-2 px-4 py-3">
            <p className="break-words text-[13.5px] text-muted">
              <span className="font-medium text-fg">Archived: {p.archived.label}</span> · {day(p.archived.at)}
              {p.archived.by ? ` by ${p.archived.by}` : ""}. Out of the pipeline: no briefs or follow-ups. Unarchive puts it back at {p.status.replace("_", " ")}.
            </p>
            <UnarchiveButton id={p.id} />
          </div>
        ) : (
          <ArchiveButton id={p.id} />
        )}
        {client && (
          <p className="rounded-[14px] bg-ok-soft px-4 py-3 text-[13.5px] text-ok">
            Won and enrolled as{" "}
            <Link href={`/clients/${client.slug}`} className="font-medium underline">
              {client.name}
            </Link>
            .{docs.length ? " Ask your assistant to move its documents to the client's Headquarters." : ""}
          </p>
        )}
        {p.status === "won" && !client && <p className="rounded-[14px] bg-warn-soft px-4 py-3 text-[13.5px] text-warn">Won. Enroll them in Kaizen Track: that creates the client and starts onboarding, and this prospect links to it on its own.</p>}
      </header>

      <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 md:mx-0 md:px-0" role="tablist">
        {(
          [
            ["brief", "Research"],
            ["drafts", `Drafts & calls${drafts ? ` (${drafts})` : ""}`],
            ["notes", "Notes & documents"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => pushParams({ tab: k === "brief" ? null : k })} className={`inline-flex h-11 shrink-0 snap-start items-center whitespace-nowrap rounded-full px-4 text-[14px] transition-colors md:h-9 md:text-[13px] ${tab === k ? "bg-fg text-bg" : "bg-surface text-muted hover:text-fg"}`}>
            {label}
          </button>
        ))}
      </div>

      {calls.length > 0 && (
        <section className="grid min-w-0 gap-2">
          <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Sales calls</h2>
          <ul className="grid min-w-0 gap-2">
            {calls.map((c) => (
              <li key={c.id}>
                <Link href={`/sales/briefs/${c.id}`} className="flex min-h-11 min-w-0 flex-wrap items-center justify-between gap-2 rounded-[14px] border border-line bg-surface px-4 py-2.5 hover:bg-surface-2">
                  <span className="min-w-0 break-words text-[14px]">{c.title}</span>
                  <span className="text-[12.5px] text-muted">{day(c.startsAt)} · {c.status === "ready" ? "brief ready" : c.status === "pending" ? "brief 18h before" : c.status}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "brief" && gtmSlot}
      {tab === "brief" && <BriefTab p={p} brief={brief} />}
      {tab === "drafts" && <DraftsTab p={p} notes={notes} researched={Boolean(brief)} />}
      {tab === "notes" && <NotesTab p={p} docs={docs} />}
    </div>
  );
}

function OwnerSelect({ id, ownerId, people, meId }: { id: string; ownerId: string | null; people: { id: string; name: string }[]; meId: string }) {
  const router = useRouter();
  const [value, setValue] = useState(ownerId ?? "");
  const [pending, start] = useTransition();
  return (
    <label className="grid">
      <span className="sr-only">Owner</span>
      <select
        value={value}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          setValue(next);
          start(async () => {
            const r = await updateAction(id, { owner_id: next || null });
            if (r.ok) router.refresh();
            else setValue(ownerId ?? "");
          });
        }}
        className="h-11 min-w-0 rounded-full border border-line bg-surface px-3.5 text-[16px] text-fg md:h-9 md:text-[13px]"
      >
        <option value="">No owner</option>
        {people.map((x) => (
          <option key={x.id} value={x.id}>
            {x.id === meId ? `${x.name} (me)` : x.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function WonButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="grid gap-1">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await wonAction(id);
            if (!r.ok) setMsg(r.error);
            else {
              setMsg(r.client ? `Linked to ${r.client.name}.` : null);
              router.refresh();
            }
          })
        }
        className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-ok-soft px-4 text-[14px] font-medium text-ok hover:opacity-90 md:h-9 md:text-[13px]"
      >
        {pending && <Spinner />}
        Mark won
      </button>
      {msg && <span className="text-[12px] text-muted">{msg}</span>}
    </div>
  );
}

function Rerun({ p, label }: { p: P; label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await researchAction({ prospectId: p.id, name: p.name, website: p.website ?? undefined, location: p.location ?? undefined });
            if (!r.ok) setError(r.error);
            else router.refresh();
          })
        }
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-60 sm:w-auto md:h-9 md:text-[13px]"
      >
        {pending && <Spinner />}
        {pending ? "Researching… (a minute or two)" : label}
      </button>
      {error && <p className="text-[13px] text-bad">{error}</p>}
    </div>
  );
}

/** The market around them: area and buyer, TAM, who advertises and how, search demand, sourced benchmarks, email */
function MarketBlock({ m }: { m: ProspectBrief["market"] | undefined }) {
  if (!m || !(m.geo || m.avatar || m.competitors.length || m.trends.length || m.benchmarks.length)) return null;
  const row = (k: string, v: string) =>
    v ? (
      <div className="grid min-w-0 gap-0.5 rounded-[14px] bg-bg p-3">
        <dt className="text-[12px] font-medium text-faint">{k}</dt>
        <dd className="break-words text-[13.5px] leading-relaxed text-fg">{v}</dd>
      </div>
    ) : null;
  return (
    <Block title="The market">
      <dl className="grid min-w-0 gap-3 md:grid-cols-2">
        {row("Area and income", m.geo)}
        {row("The buyer", m.avatar)}
        {row("Total addressable market", m.tam)}
        {row("Seasonality", m.seasonality)}
        {row("Email programs (public archives)", m.email_intel)}
      </dl>
      {m.competitors.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[12px] font-medium text-faint">Who&apos;s advertising (internal: never named in client documents)</p>
          {m.competitors.map((c, i) => (
            <div key={i} className="grid min-w-0 gap-1 rounded-[14px] border border-line p-3 text-[13px] leading-relaxed">
              <p className="break-words font-medium">{c.name}{c.channels ? <span className="font-normal text-muted"> · {c.channels}</span> : null}</p>
              {c.funnel && <p className="break-words text-muted">Funnel: {c.funnel}</p>}
              {c.messaging && <p className="break-words text-muted">Messaging: {c.messaging}</p>}
              {(c.offer || c.usp) && <p className="break-words text-muted">{[c.offer && `Offer: ${c.offer}`, c.usp && `USP: ${c.usp}`].filter(Boolean).join(" · ")}</p>}
            </div>
          ))}
        </div>
      )}
      {m.trends.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[12px] font-medium text-faint">Search demand</p>
          <ul className="grid gap-1.5">
            {m.trends.map((t, i) => (
              <li key={i} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line pb-1.5 text-[13px]">
                <span className="min-w-0 break-words">{t.keyword}</span>
                <span className="tabular-nums text-muted">{[t.cpc && `CPC ${t.cpc}`, t.volume && `${t.volume}/mo`].filter(Boolean).join(" · ")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {m.benchmarks.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[12px] font-medium text-faint">Benchmarks</p>
          <ul className="grid gap-1.5">
            {m.benchmarks.map((b, i) => (
              <li key={i} className="break-words text-[13px] leading-relaxed">
                <span className="font-medium">{b.platform} {b.metric}: {b.value}</span>
                <span className="text-muted"> · {b.source}{b.proxy ? ` · stand-in: ${b.proxy}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Block>
  );
}

function BriefTab({ p, brief }: { p: P; brief: ProspectBrief | null }) {
  if (!brief)
    return (
      <Block title="Research">
        <p className="text-[14px] leading-relaxed text-muted">{p.fitReason ? `${p.fitReason}. ` : ""}Not researched yet. The Sales agent reads the site, reviews, social and the public ad libraries, then writes the brief and a Kaizen strategy.</p>
        <Rerun p={p} label="Research it now" />
      </Block>
    );
  const m = brief.marketing;
  const marketing = (
    [
      ["Website", m.site],
      ["Offers", m.offers],
      ["Reviews", m.reviews],
      ["Social", m.social],
      ["Meta ads", m.meta_ads],
      ["Google ads", m.google_ads],
      ["Email capture", m.email_capture],
    ] as const
  ).filter(([, v]) => v);
  const st = brief.strategy;
  return (
    <div className="grid min-w-0 gap-4">
      <Block title="The opportunity" aside={<Rerun p={p} label="Research again" />}>
        <p className="break-words text-[16px] leading-relaxed text-fg">{brief.summary}</p>
        {brief.fit_reason && (
          <p className="break-words text-[13.5px] leading-relaxed text-muted">
            <span className="font-medium text-fg">Fit {brief.fit_score ?? "?"}/100.</span> {brief.fit_reason}
          </p>
        )}
        {p.researchedAt && <p className="text-[12px] text-faint">Researched {day(p.researchedAt)}</p>}
      </Block>

      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Block title="What they sell">
          <p className="break-words text-[14px] leading-relaxed">{brief.sells || "Not visible."}</p>
          {brief.locations.length > 0 && <p className="break-words text-[13.5px] text-muted">{brief.locations.join(" · ")}</p>}
        </Block>
        <Block title="Positioning">
          <p className="break-words text-[14px] leading-relaxed">{brief.positioning || "Not visible."}</p>
        </Block>
      </div>

      {marketing.length > 0 && (
        <Block title="Their marketing today">
          <dl className="grid min-w-0 gap-3 md:grid-cols-2">
            {marketing.map(([k, v]) => (
              <div key={k} className="grid min-w-0 gap-0.5 rounded-[14px] bg-bg p-3">
                <dt className="text-[12px] font-medium text-faint">{k}</dt>
                <dd className="break-words text-[13.5px] leading-relaxed text-fg">{v}</dd>
              </div>
            ))}
          </dl>
        </Block>
      )}

      <MarketBlock m={brief.market} />

      <Block title="Kaizen strategy">
        {st.angle && (
          <div className="grid gap-1 rounded-[14px] bg-brand-soft p-4">
            <p className="text-[12px] font-medium text-brand-text">The angle</p>
            <p className="break-words text-[15px] leading-relaxed text-fg">{st.angle}</p>
          </div>
        )}
        {st.services.length > 0 && (
          <ul className="grid gap-2">
            {st.services.map((s, i) => (
              <li key={i} className="grid min-w-0 gap-1 rounded-[14px] border border-line p-3">
                <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
                  <span className="break-words text-[14px] font-medium">{s.service}</span>
                  {s.price && <span className="text-[13px] tabular-nums text-muted">{s.price}</span>}
                </div>
                <p className="break-words text-[13.5px] leading-relaxed text-muted">{s.why}</p>
              </li>
            ))}
          </ul>
        )}
        {st.talking_points.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[12px] font-medium text-faint">First-outreach talking points</p>
            <Bullets items={st.talking_points} />
          </div>
        )}
        {st.proof.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[12px] font-medium text-faint">Proof from similar Kaizen clients (internal: describe by industry, never by name)</p>
            <Bullets items={st.proof} />
          </div>
        )}
        <Link href="?tab=drafts" className="inline-flex h-11 w-fit items-center rounded-full border border-line px-4 text-[14px] hover:bg-surface-2 md:h-9 md:text-[13px]">
          Draft the outreach →
        </Link>
      </Block>

      {(brief.tiers ?? []).length > 0 && (
        <Block title="Tiers">
          <div className="grid min-w-0 gap-3 md:grid-cols-3">
            {brief.tiers.map((t, i) => (
              <div key={i} className={`grid min-w-0 content-start gap-2 rounded-[16px] border p-4 ${i === 1 ? "border-brand/50 bg-brand-soft" : "border-line"}`}>
                <p className="break-words text-[14px] font-medium">{t.name}</p>
                <ul className="grid gap-1">
                  {t.services.map((x, j) => (
                    <li key={j} className="break-words text-[13px] leading-relaxed text-muted">
                      · {x}
                    </li>
                  ))}
                </ul>
                {t.ad_spend && <p className="break-words text-[13px]"><span className="text-faint">Ad spend </span>{t.ad_spend}</p>}
                {t.fees && <p className="break-words text-[13px]"><span className="text-faint">Fees </span>{t.fees}</p>}
                {t.projection && <p className="break-words text-[13px]"><span className="text-faint">Projection </span>{t.projection}</p>}
                {t.best_for && <p className="break-words text-[12.5px] text-faint">{t.best_for}</p>}
              </div>
            ))}
          </div>
        </Block>
      )}

      {brief.gaps.length > 0 && (
        <Block title="Likely gaps">
          <Bullets items={brief.gaps} />
        </Block>
      )}

      {brief.contacts.length > 0 && (
        <Block title="People found (public)">
          <ul className="grid gap-2">
            {brief.contacts.map((c, i) => (
              <li key={i} className="break-words text-[14px]">
                <span className="font-medium">{c.name}</span>
                {c.role && <span className="text-muted"> · {c.role}</span>}
                {c.where && <span className="text-faint"> · {c.where}</span>}
              </li>
            ))}
          </ul>
        </Block>
      )}

      {brief.sources.length > 0 && (
        <details className="group rounded-[20px] border border-line bg-surface p-4 md:p-6">
          <summary className="flex min-h-11 cursor-pointer list-none items-center text-[13px] text-muted hover:text-fg md:min-h-0">Sources ({brief.sources.length})</summary>
          <ul className="mt-3 grid gap-1.5">
            {brief.sources.map((s, i) => (
              <li key={i} className="min-w-0 break-all text-[13px]">
                {/^https?:\/\//.test(s) ? (
                  <a href={s} target="_blank" rel="noopener noreferrer" className="inline-block py-2.5 text-brand-text hover:underline md:py-0">
                    {s}
                  </a>
                ) : (
                  s
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function DraftsTab({ p, notes, researched }: { p: P; notes: ProspectNote[]; researched: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [reviewing, startReview] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <Block title="Draft the outreach">
          <p className="text-[13.5px] leading-relaxed text-muted">A call script, an email and a LinkedIn note and message, in Kaizen&apos;s voice{researched ? ", built on the research" : " (research it first to make them specific)"}. You send them yourself.</p>
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const focus = String(new FormData(e.currentTarget).get("focus") ?? "");
              setError(null);
              start(async () => {
                const r = await pitchAction(p.id, focus);
                if (!r.ok) setError(r.error);
                else router.refresh();
              });
            }}
          >
            <input name="focus" placeholder="Lean on anything? (optional: an offer, a service, a tone)" className={`${field} h-11`} autoComplete="off" />
            <button type="submit" disabled={pending} className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-brand px-5 text-[14px] font-medium text-white hover:bg-brand-hover disabled:opacity-60">
              {pending && <Spinner />}
              {pending ? "Writing…" : "Draft it"}
            </button>
            {error && <p className="text-[13px] text-bad">{error}</p>}
          </form>
        </Block>
        <Block title="Review a sales call">
          <p className="text-[13.5px] leading-relaxed text-muted">Paste the transcript or the meeting notes&apos; Google Doc link. You get what went well, objections with better answers, next steps and the proposal to send.</p>
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              setReviewError(null);
              startReview(async () => {
                const r = await reviewAction(p.id, { transcript: String(f.get("transcript") ?? ""), doc: String(f.get("doc") ?? "") });
                if (!r.ok) setReviewError(r.error);
                else router.refresh();
              });
            }}
          >
            <input name="doc" placeholder="Google Doc link (Gemini notes or transcript)" inputMode="url" className={`${field} h-11`} autoComplete="off" />
            <textarea name="transcript" rows={4} placeholder="…or paste the transcript" className={`${field} py-2.5`} />
            <button type="submit" disabled={reviewing} className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-line bg-surface px-5 text-[14px] font-medium text-fg hover:bg-surface-2 disabled:opacity-60">
              {reviewing && <Spinner />}
              {reviewing ? "Reviewing…" : "Review the call"}
            </button>
            {reviewError && <p className="text-[13px] text-bad">{reviewError}</p>}
          </form>
        </Block>
      </div>

      {notes.length === 0 && <p className="px-1 text-[13.5px] text-muted">No drafts or call reviews yet.</p>}
      {notes.map((n) => (n.kind === "pitch" ? <PitchCard key={n.id} prospectId={p.id} n={n} /> : <ReviewCard key={n.id} prospectId={p.id} n={n} />))}
    </div>
  );
}

function Remove({ prospectId, noteId }: { prospectId: string; noteId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" disabled={pending} onClick={() => start(async () => void ((await deleteNoteAction(prospectId, noteId)).ok && router.refresh()))} className="inline-flex h-11 items-center rounded-full px-3 text-[12.5px] text-faint hover:text-bad md:h-8">
      {pending ? "Removing…" : "Remove"}
    </button>
  );
}

function PitchCard({ prospectId, n }: { prospectId: string; n: Extract<ProspectNote, { kind: "pitch" }> }) {
  const c = n.pitch.call_script;
  const script = [c.opener, c.questions.length ? `Questions:\n${c.questions.map((q) => `- ${q}`).join("\n")}` : "", c.angle && `Angle: ${c.angle}`, c.ask && `Ask: ${c.ask}`, c.objections.length ? `Objections:\n${c.objections.map((o) => `- "${o.objection}" → ${o.answer}`).join("\n")}` : ""].filter(Boolean).join("\n\n");
  const email = `Subject: ${n.pitch.email.subject}\n\n${n.pitch.email.body}`;
  return (
    <Block title={`${n.title} · ${day(n.at)}`} aside={<Remove prospectId={prospectId} noteId={n.id} />}>
      <div className="grid min-w-0 gap-4">
        <Draft label="Call script" copy={script}>
          <p className="break-words">{c.opener}</p>
          {c.questions.length > 0 && <Bullets items={c.questions} />}
          {c.angle && (
            <p className="break-words">
              <span className="text-muted">Angle: </span>
              {c.angle}
            </p>
          )}
          {c.ask && (
            <p className="break-words">
              <span className="text-muted">Ask: </span>
              {c.ask}
            </p>
          )}
          {c.objections.map((o, i) => (
            <p key={i} className="break-words">
              <span className="text-muted">&ldquo;{o.objection}&rdquo; → </span>
              {o.answer}
            </p>
          ))}
        </Draft>
        <Draft label="Email" copy={email}>
          <p className="break-words font-medium">{n.pitch.email.subject}</p>
          <p className="whitespace-pre-wrap break-words">{n.pitch.email.body}</p>
        </Draft>
        <Draft label={`LinkedIn connection note · ${n.pitch.linkedin.connection_note.length}/300`} copy={n.pitch.linkedin.connection_note}>
          <p className="whitespace-pre-wrap break-words">{n.pitch.linkedin.connection_note}</p>
        </Draft>
        <Draft label="LinkedIn message (after they accept)" copy={n.pitch.linkedin.message}>
          <p className="whitespace-pre-wrap break-words">{n.pitch.linkedin.message}</p>
        </Draft>
        <p className="text-[12px] text-faint">Sent by you, by hand. Nothing here connects to or messages anyone on LinkedIn.</p>
      </div>
    </Block>
  );
}

function Draft({ label, copy, children }: { label: string; copy: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-2 rounded-[14px] bg-bg p-3.5 md:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-medium text-faint">{label}</p>
        <Copy text={copy} />
      </div>
      <div className="grid min-w-0 gap-2 text-[14px] leading-relaxed text-fg">{children}</div>
    </div>
  );
}

function ReviewCard({ prospectId, n }: { prospectId: string; n: Extract<ProspectNote, { kind: "call_review" }> }) {
  const r = n.review;
  return (
    <Block title={`${n.title} · ${day(n.at)}`} aside={<Remove prospectId={prospectId} noteId={n.id} />}>
      <p className="break-words text-[15px] leading-relaxed">{r.summary}</p>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        {r.went_well.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[12px] font-medium text-ok">Went well</p>
            <Bullets items={r.went_well} />
          </div>
        )}
        {r.improve.length > 0 && (
          <div className="grid gap-2">
            <p className="text-[12px] font-medium text-warn">Do better</p>
            <Bullets items={r.improve} />
          </div>
        )}
      </div>
      {r.objections.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[12px] font-medium text-faint">Objections</p>
          {r.objections.map((o, i) => (
            <div key={i} className="grid min-w-0 gap-1 rounded-[14px] bg-bg p-3 text-[13.5px] leading-relaxed">
              <p className="break-words font-medium">&ldquo;{o.objection}&rdquo;</p>
              {o.how_handled && <p className="break-words text-muted">Handled: {o.how_handled}</p>}
              {o.better_answer && <p className="break-words">Better: {o.better_answer}</p>}
            </div>
          ))}
        </div>
      )}
      {r.next_steps.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[12px] font-medium text-faint">Next steps</p>
          <Bullets items={r.next_steps.map((s) => [s.step, s.who && `(${s.who})`, s.when && `· ${s.when}`].filter(Boolean).join(" "))} />
        </div>
      )}
      {r.proposal.send && (
        <div className="grid gap-1 rounded-[14px] bg-brand-soft p-4 text-[14px]">
          <p className="text-[12px] font-medium text-brand-text">Send a proposal</p>
          {r.proposal.services.length > 0 && <p className="break-words">{r.proposal.services.join(" · ")}</p>}
          {r.proposal.note && <p className="break-words text-muted">{r.proposal.note}</p>}
          <p className="text-[12.5px] text-muted">Ask your assistant or the Sales agent: &ldquo;Make the proposal for this prospect.&rdquo; It&apos;s made in Google Slides from Kaizen&apos;s template and filed in Kaizen Sales › Prospects.</p>
        </div>
      )}
    </Block>
  );
}

function NotesTab({ p, docs }: { p: P; docs: { id: string; title: string; link: string | null; folder: string | null }[] }) {
  const router = useRouter();
  const [saved, setSaved] = useState<string | null>(null);
  const [, start] = useTransition();
  const save = (patch: { notes?: string; lost_reason?: string }) =>
    start(async () => {
      const r = await updateAction(p.id, patch);
      setSaved(r.ok ? "Saved" : r.error);
      if (r.ok) router.refresh();
    });
  return (
    <div className="grid min-w-0 gap-4">
      <Block title="Team notes" aside={saved ? <span className="text-[12px] text-faint">{saved}</span> : null}>
        <textarea defaultValue={p.notes ?? ""} rows={6} onBlur={(e) => e.target.value !== (p.notes ?? "") && save({ notes: e.target.value })} placeholder="Who you spoke to, what they said, what's next. Saved when you click away." className={`${field} py-2.5`} />
        {p.status === "lost" && <input defaultValue={p.lostReason ?? ""} onBlur={(e) => e.target.value !== (p.lostReason ?? "") && save({ lost_reason: e.target.value })} placeholder="Why it was lost" className={`${field} h-11`} />}
        {p.source && <p className="break-words text-[12px] text-faint">Came from: {p.source}</p>}
      </Block>
      <Block title="Documents">
        {docs.length === 0 ? (
          <p className="text-[13.5px] leading-relaxed text-muted">No proposal or SOW yet. Ask your assistant or the Sales agent: &ldquo;Make a proposal for {p.name}.&rdquo; It&apos;s made from Kaizen&apos;s templates with rate card prices, and filed in Kaizen Sales › Prospects › {p.name} once you confirm the folder.</p>
        ) : (
          <ul className="grid gap-2">
            {docs.map((d) => (
              <li key={d.id} className="grid min-w-0 gap-0.5 rounded-[14px] border border-line p-3">
                {d.link ? (
                  <a href={d.link} target="_blank" rel="noopener noreferrer" className="break-words text-[14px] font-medium text-brand-text hover:underline">
                    {d.title} ↗
                  </a>
                ) : (
                  <span className="break-words text-[14px] font-medium">{d.title}</span>
                )}
                {d.folder && <span className="break-words text-[12.5px] text-faint">{d.folder}</span>}
              </li>
            ))}
          </ul>
        )}
      </Block>
    </div>
  );
}
