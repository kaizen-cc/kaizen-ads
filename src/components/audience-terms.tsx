"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { checkAudienceTerms, type TermsResult, type TermsRow } from "@/app/(team)/settings/meta-write-actions";
import { pushParams, replaceParams, useParam } from "@/lib/url-state";

type Loaded = Extract<TermsResult, { ok: true }>;
type Status = TermsRow["status"];
export type MetaAccessState = { data: Loaded | null; error: string | null; busy: boolean; reload: () => void };

/**
 * The groups every Meta ad account falls in, worst first. Each account is in exactly one (worked out on the server),
 * so the counts, the headline and the lists all read the same rows.
 */
export const ACCESS_GROUPS: { key: Status; label: string; tone: "bad" | "warn" | "ok"; about: string }[] = [
  { key: "none", label: "Not assigned", tone: "bad", about: "Our system user can't see these accounts, so nothing can be read or changed." },
  { key: "view", label: "View only", tone: "warn", about: "Assigned to view performance only, so Meta refuses every change." },
  { key: "terms", label: "Customer-list terms", tone: "warn", about: "They use customer lists, and Kaizen hasn't accepted Meta's Custom Audience terms on them." },
  { key: "ready", label: "Ready", tone: "ok", about: "Every change goes through." },
];
const PROBLEMS: Status[] = ["none", "view", "terms"];

/** How many accounts sit in each group, and how many can't take every change (the three problem groups). */
export function accessCounts(rows: TermsRow[]) {
  const by = { none: 0, view: 0, terms: 0, ready: 0 } as Record<Status, number>;
  for (const r of rows) by[r.status]++;
  return { by, total: rows.length, problems: by.none + by.view + by.terms, ready: by.ready };
}

const FAILED = { ok: false as const, error: "Couldn't reach Meta. Try again." };

function useLoader(clientId: string | undefined, skip: boolean): MetaAccessState {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const apply = useCallback((r: TermsResult) => {
    if (r.ok) {
      setData(r);
      setError(null);
    } else setError(r.error);
  }, []);
  const reload = useCallback(() => {
    setBusy(true);
    checkAudienceTerms(clientId)
      .catch(() => FAILED)
      .then((r) => {
        setBusy(false);
        apply(r);
      });
  }, [clientId, apply]);
  useEffect(() => {
    if (skip) return;
    let live = true;
    checkAudienceTerms(clientId)
      .catch(() => FAILED)
      .then((r) => {
        if (live) apply(r);
      });
    return () => {
      live = false;
    };
  }, [clientId, apply, skip]);
  return { data, error, busy, reload };
}

const Ctx = createContext<MetaAccessState | null>(null);

/** Checks every client's Meta access once, for the Sync health summary and the Meta access section together. */
export function MetaAccessProvider({ children }: { children: ReactNode }) {
  const state = useLoader(undefined, false);
  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** The shared check, inside a MetaAccessProvider (null outside one). */
export const useMetaAccess = () => useContext(Ctx);

const TONE = {
  bad: { dot: "bg-bad", chip: "bg-bad-soft text-bad" },
  warn: { dot: "bg-warn", chip: "bg-warn-soft text-warn" },
  ok: { dot: "bg-ok", chip: "bg-ok-soft text-ok" },
  soft: { dot: "bg-faint", chip: "bg-surface-2 text-muted" },
} as const;

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** Ready, but without the terms on an account that has no customer lists: a note, not a problem */
const softTerms = (r: TermsRow) => r.status === "ready" && r.accepted === false;

/**
 * Can Kaizen Ads change each Meta ad account? Per account: is our system user assigned with Manage campaigns (or only
 * view, or not at all), and, on accounts that use customer lists, has Kaizen's Business Manager accepted Meta's Custom
 * Audience terms (without them Meta refuses any change to an ad set that targets a list, pausing too). Plus the
 * token's own permissions, once. One client's accounts (the live-changes widget) or every client's (Sync health,
 * grouped by problem with search and filters in the address).
 */
export function AudienceTermsCheck({ clientId }: { clientId?: string }) {
  const shared = useMetaAccess();
  const useShared = Boolean(shared) && !clientId;
  const own = useLoader(clientId, useShared);
  const { data, error, busy, reload } = useShared && shared ? shared : own;
  const all = !clientId;
  const business = data?.business ?? null;
  const bizName = business?.name ?? "Kaizen Marketing";

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid min-w-0 gap-0.5">
          <p className={all ? "font-heading text-lg" : "text-[11px] font-semibold uppercase tracking-[0.14em] text-faint"}>Meta access for changes</p>
          {data && <p className="text-[12px] text-faint">Checked with Meta {ago(data.checkedAt)}</p>}
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={reload}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-fg/30 hover:text-fg disabled:opacity-60 md:min-h-9"
        >
          {busy && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden />}
          {busy ? "Checking…" : "Check again"}
        </button>
      </div>
      {error && <p className="text-[13px] text-bad">{error}</p>}
      {!data && !error && (
        <div className="grid gap-2" aria-label="Checking with Meta">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-[14px] bg-surface-2" />
          ))}
        </div>
      )}
      {data && data.tokenMissing.length > 0 && (
        <p className="rounded-[14px] border border-bad/30 bg-bad-soft px-4 py-3 text-[13px] leading-relaxed">
          The system user&rsquo;s token is missing <span className="font-medium">{data.tokenMissing.join(", ")}</span>, so changes fail on every account. In Business Manager: Users › System users › Generate new token
          with those ticked, then replace META_SYSTEM_USER_TOKEN in Vercel and redeploy.
        </p>
      )}
      {data && !data.rows.length && <p className="text-[13px] text-muted">No Meta ad account is set up {all ? "for any client" : "for this client"} yet.</p>}
      {data && data.rows.length > 0 && (all ? <Grouped rows={data.rows} bizName={bizName} hasBiz={Boolean(business)} /> : <Flat rows={data.rows} bizName={bizName} hasBiz={Boolean(business)} />)}
    </div>
  );
}

/** One client's accounts: a line saying whether every change goes through, then each account. */
function Flat({ rows, bizName, hasBiz }: { rows: TermsRow[]; bizName: string; hasBiz: boolean }) {
  const c = accessCounts(rows);
  return (
    <div className="grid gap-2.5">
      <p className={`text-[13px] leading-relaxed ${c.problems ? "text-muted" : "text-ok"}`}>
        {c.problems ? `${c.problems} of ${c.total} ${c.total === 1 ? "account" : "accounts"} can't take every change yet. Fix each with its button, then Check again.` : "Ready: the system user can make every change here."}
      </p>
      <ul className="grid divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-surface">
        {rows.map((r) => (
          <AccountRow key={r.account} r={r} all={false} bizName={bizName} hasBiz={hasBiz} />
        ))}
      </ul>
    </div>
  );
}

/** Every client's accounts, by problem: groups with counts, search by client, and a filter for live changes. */
function Grouped({ rows, bizName, hasBiz }: { rows: TermsRow[]; bizName: string; hasBiz: boolean }) {
  const q = useParam("q") ?? "";
  const liveOnly = useParam("live") === "1";
  const groupsParam = useParam("groups");
  const [query, setQuery] = useState(q);
  // Back and forward change the address under the box
  const [seen, setSeen] = useState(q);
  if (seen !== q) {
    setSeen(q);
    setQuery(q);
  }
  const counts = accessCounts(rows);
  const needle = q.trim().toLowerCase();
  const shown = useMemo(
    () => rows.filter((r) => (!liveOnly || r.live) && (!needle || [r.client, r.name, r.account, r.owner].some((x) => x?.toLowerCase().includes(needle)))),
    [rows, liveOnly, needle],
  );
  const shownBy = accessCounts(shown).by;
  const liveCount = rows.filter((r) => r.live).length;
  // Open groups: from the address, or every problem group that has accounts (so every problem is one look away)
  const open = new Set<Status>(groupsParam === null ? PROBLEMS.filter((k) => counts.by[k] > 0) : groupsParam === "none" ? [] : (groupsParam.split(",") as Status[]));
  const toggle = (k: Status) => {
    const next = new Set(open);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    pushParams({ groups: next.size ? ACCESS_GROUPS.filter((g) => next.has(g.key)).map((g) => g.key).join(",") : "none" });
  };
  const filtering = Boolean(needle) || liveOnly;

  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-3 rounded-[18px] border border-line bg-surface p-4">
        <p className="text-[14px] leading-relaxed">
          {counts.problems ? (
            <>
              <span className="tabular font-medium">{counts.problems}</span> of <span className="tabular">{counts.total}</span> ad accounts can&rsquo;t take every change yet.
              <span className="text-muted"> Fix each with its button, then Check again.</span>
            </>
          ) : (
            <span className="text-ok">All {counts.total} ad accounts are ready for changes.</span>
          )}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {ACCESS_GROUPS.map((g) => (
            <button
              key={g.key}
              type="button"
              onClick={() => {
                if (!open.has(g.key)) toggle(g.key);
                document.getElementById(`access-${g.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={`inline-flex min-h-9 items-center gap-2 rounded-full px-3 text-[12.5px] transition-opacity hover:opacity-85 max-md:min-h-11 ${counts.by[g.key] ? TONE[g.tone].chip : "bg-surface-2 text-faint"}`}
            >
              {g.label}
              <span className="tabular font-medium">{counts.by[g.key]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 basis-56">
          <span className="sr-only">Search by client or account</span>
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              replaceParams({ q: e.target.value.trim() || null });
            }}
            placeholder="Search client or account"
            className="h-11 w-full rounded-full border border-line bg-surface px-4 text-[14px] outline-none placeholder:text-faint focus:border-brand/60 md:h-10"
          />
        </label>
        <button
          type="button"
          onClick={() => pushParams({ live: liveOnly ? null : "1" })}
          aria-pressed={liveOnly}
          className={`inline-flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-[13px] transition-colors md:h-10 ${liveOnly ? "bg-ok-soft text-ok" : "border border-line text-muted hover:text-fg"}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${liveOnly ? "bg-ok" : "bg-faint"}`} aria-hidden />
          Live changes on
          <span className="tabular text-[12px] opacity-80">{liveCount}</span>
        </button>
      </div>

      <div className="grid gap-3">
        {ACCESS_GROUPS.map((g) => {
          const list = shown.filter((r) => r.status === g.key);
          const isOpen = open.has(g.key);
          if (!counts.by[g.key]) return null;
          return (
            <section key={g.key} id={`access-${g.key}`} className="min-w-0 scroll-mt-24 overflow-hidden rounded-[18px] border border-line bg-surface">
              <button type="button" onClick={() => toggle(g.key)} aria-expanded={isOpen} className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left">
                <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[g.tone].dot}`} aria-hidden />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span className="flex items-baseline gap-2">
                    <span className="font-heading text-[15px]">{g.label}</span>
                    <span className="tabular text-[13px] text-muted">{filtering ? `${shownBy[g.key]} of ${counts.by[g.key]}` : counts.by[g.key]}</span>
                  </span>
                  <span className="truncate text-[12px] text-faint max-md:whitespace-normal">{g.about}</span>
                </span>
                <span className={`shrink-0 text-faint transition-transform ${isOpen ? "rotate-180" : ""}`} aria-hidden>
                  ⌄
                </span>
              </button>
              {isOpen &&
                (list.length ? (
                  <ul className="grid divide-y divide-line border-t border-line">
                    {list.map((r) => (
                      <AccountRow key={r.account} r={r} all bizName={bizName} hasBiz={hasBiz} />
                    ))}
                  </ul>
                ) : (
                  <p className="border-t border-line px-4 py-3 text-[12.5px] text-faint">None match the search{liveOnly ? " with live changes on" : ""}.</p>
                ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** One ad account: a single line (client, account, status, the one fix) that opens to the why and the details. */
function AccountRow({ r, all, bizName, hasBiz }: { r: TermsRow; all: boolean; bizName: string; hasBiz: boolean }) {
  const [open, setOpen] = useState(false);
  const soft = softTerms(r);
  const tone = r.status === "none" ? "bad" : r.status === "ready" ? (soft ? "soft" : "ok") : "warn";
  const chip = r.status === "none" ? "Not assigned" : r.status === "view" ? "View only" : r.status === "terms" ? "Terms missing" : soft ? "Ready · no lists" : "Ready";
  const action =
    r.status === "none"
      ? { href: r.assignUrl, label: "Assign", title: "Assign the system user with Manage campaigns" }
      : r.status === "view"
        ? { href: r.assignUrl, label: "Give access", title: "Turn on Manage campaigns for the system user" }
        : r.status === "terms"
          ? { href: r.url, label: "Accept terms", title: r.via ? `Accept as ${r.via}, the business our changes go through` : `Accept as ${bizName}, not as the client` }
          : null;
  const title = all ? (r.client ?? r.name ?? "Ad account") : (r.name ?? "Ad account");
  // Which token a change goes through: the client's Business Manager (a partner's), or Kaizen's
  const via = r.via ? `via ${r.via}'s business` : `via ${bizName}'s business`;
  const sub = `${all ? `${r.name ?? "Ad account"} · ${r.account}` : r.account} · ${via}`;

  return (
    <li className="min-w-0">
      <div className="flex items-center gap-2 px-3 py-2 md:gap-3 md:px-4">
        <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex min-h-12 min-w-0 flex-1 items-center gap-3 text-left">
          <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[tone].dot}`} aria-hidden />
          <span className="grid min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[14px] font-medium">{title}</span>
              {all && r.live && (
                <span className="shrink-0 whitespace-nowrap rounded-full bg-ok-soft px-1.5 py-px text-[10.5px] font-medium text-ok" title="Live changes are on for this client">
                  Live
                </span>
              )}
            </span>
            <span className="truncate text-[12px] text-faint">{sub}</span>
          </span>
          <span className={`hidden shrink-0 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium sm:inline ${TONE[tone].chip}`}>{chip}</span>
        </button>
        {action && (
          <a
            href={action.href}
            target="_blank"
            rel="noreferrer"
            title={action.title}
            className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-full bg-brand px-3.5 text-[12.5px] font-medium text-white hover:bg-brand-hover md:min-h-9"
          >
            {action.label} ↗
          </a>
        )}
        <button type="button" onClick={() => setOpen((v) => !v)} aria-label={open ? "Hide details" : "Show details"} className="grid h-11 w-8 shrink-0 place-items-center text-faint hover:text-fg">
          <span className={`transition-transform ${open ? "rotate-180" : ""}`} aria-hidden>
            ⌄
          </span>
        </button>
      </div>
      {open && (
        <div className="grid gap-3 px-4 pb-4 pl-8 md:pl-9">
          <span className={`justify-self-start rounded-full px-2 py-0.5 text-[11px] font-medium sm:hidden ${TONE[tone].chip}`}>{chip}</span>
          <p className="max-w-[70ch] text-[13px] leading-relaxed text-muted">{why(r, bizName, hasBiz)}</p>
          <dl className="grid gap-x-4 gap-y-1 text-[12px] sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-faint">Account</dt>
            <dd className="tabular text-muted [overflow-wrap:anywhere]">
              {r.name ?? "Unnamed"} · {r.account}
            </dd>
            <dt className="text-faint">Changes go</dt>
            <dd className="text-muted">{r.via ? `${via}, with the token connected for it` : `${via}, with Kaizen's own token`}</dd>
            {r.owner && (
              <>
                <dt className="text-faint">Owned by</dt>
                <dd className="text-muted">{r.owner}</dd>
              </>
            )}
            {r.access !== "none" && (
              <>
                <dt className="text-faint">Customer lists</dt>
                <dd className="text-muted">
                  {r.accepted ? "Terms accepted" : r.usesLists === false ? "None in the account, so the terms block nothing" : r.usesLists ? "Used, terms not accepted" : "Couldn't tell, counted as used"}
                </dd>
              </>
            )}
            {r.tosKeys.length > 0 && (
              <>
                <dt className="text-faint">Meta reports</dt>
                <dd className="font-mono text-[11px] text-faint [overflow-wrap:anywhere]">{r.tosKeys.join(", ")}</dd>
              </>
            )}
            {r.error && (
              <>
                <dt className="text-faint">Meta said</dt>
                <dd className="text-faint [overflow-wrap:anywhere]">{r.error}</dd>
              </>
            )}
          </dl>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
            {all && r.slug && (
              <Link href={`/clients/${r.slug}?tab=team`} className="inline-flex min-h-11 items-center text-brand-text hover:underline md:min-h-0">
                Open {r.client} →
              </Link>
            )}
            {soft && (
              <a href={r.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center text-muted hover:text-fg md:min-h-0">
                Accept the terms anyway ↗
              </a>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function why(r: TermsRow, bizName: string, hasBiz: boolean) {
  // Through a partner Business Manager: its system user, its terms
  if (r.via) {
    if (r.status === "none") return `The system user connected from ${r.via}'s business can't see this account. In their Business Manager: Ad accounts › this account › Assign people › that system user › Manage campaigns, then Check again on the connection.`;
    if (r.status === "view") return `The system user connected from ${r.via}'s business can only view this account. In their Business Manager, turn on Manage campaigns for it on this account, then Check again on the connection.`;
    if (r.status === "terms") return `This account ${r.usesLists ? "uses" : "may use"} customer lists, and Meta's Custom Audience terms aren't accepted for ${r.via}'s business, which our changes go through. An admin of ${r.via}'s business accepts them once (the button opens Meta's page set to that business).`;
  }
  if (r.status === "none")
    return "Our system user can't see this account, so nothing can be read or changed. Assign it: Business settings › Ad accounts › this account › Assign people › the system user › Manage campaigns. If the account belongs to the client, they first share it with our Business Manager as a partner (with Manage campaigns).";
  if (r.status === "view")
    return `Assigned, but only to view performance, so Meta refuses every change. Turn on Manage campaigns for the system user on this account${r.owner ? ` (if ${r.owner} shares it with us as a partner, their share needs Manage campaigns first)` : ""}.`;
  if (r.status === "terms")
    return `${r.usesLists ? "This account uses customer lists" : "We couldn't tell whether this account uses customer lists"}, and Meta's Custom Audience terms aren't accepted for Kaizen, so Meta refuses changes to ad sets that target a list (pausing too). Accept as ${bizName} (our Business Manager), not as the client: the terms are held per business, and accepting for ${r.owner ?? "the client"} doesn't cover our changes. ${hasBiz ? "The button opens Meta's page already set to our business; an admin of it accepts once." : `On Meta's page, switch to ${bizName} before accepting.`}`;
  if (softTerms(r)) return "There are no customer-list audiences in this account, so the Custom Audience terms block nothing. Only needed if they use customer lists; accept them then, as Kaizen.";
  return "Assigned with Manage campaigns and the Custom Audience terms are accepted: every change goes through.";
}
