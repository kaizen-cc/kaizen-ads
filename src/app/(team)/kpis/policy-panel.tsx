"use client";

import { Fragment, useCallback, useEffect, useState, useTransition } from "react";
import type { ApplyResult, PolicyIssue } from "@/lib/ai-tools/policy";
import { pushParams, useParam } from "@/lib/url-state";
import { applyPolicyFixAction, checkEverything, policyState, requestReviewAction, type PolicyState } from "./policy-actions";

// Google policy: every disapproved or limited ad, asset and keyword in the account, worst first, each with the exact
// trigger marked. Opening one (it lives in the address, so back closes it) shows what's wrong, why (Google's own words
// and the article), what the landing page did, and the fix, with Apply the fix, the drafted appeal and Request review.

const SEV = {
  high: { dot: "bg-bad", chip: "bg-bad-soft text-bad", word: "Disapproved" },
  medium: { dot: "bg-warn", chip: "bg-warn-soft text-warn", word: "Limited" },
  low: { dot: "bg-faint", chip: "bg-surface-2 text-muted", word: "Limited by area" },
} as const;

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** The text with each trigger word or phrase marked */
function Marked({ text, triggers }: { text: string; triggers: string[] }) {
  const t = triggers.map((x) => x.trim()).filter((x) => x.length > 1);
  if (!t.length) return <>{text}</>;
  const re = new RegExp(`(${t.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[4px] bg-bad-soft px-0.5 text-bad">
            {part}
          </mark>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function triggersOf(i: PolicyIssue) {
  return i.ai?.triggers?.length ? i.ai.triggers : i.topics.flatMap((t) => t.evidence).filter((e) => e.length < 60);
}

export function PolicyPanel({ clientId, param = "policy" }: { clientId: string; param?: string }) {
  const [state, setState] = useState<PolicyState | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [starting, start] = useTransition();
  const open = useParam(param);

  const load = useCallback(() => policyState(clientId).then(setState, () => setState(null)), [clientId]);
  useEffect(() => {
    void load();
  }, [load]);
  const running = state?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [running, load]);

  const run = () =>
    start(async () => {
      setError(null);
      const r = await checkEverything(clientId);
      if (!r.ok) return setError(r.error);
      await load();
    });

  const issues = state?.issues ?? [];
  const high = issues.filter((i) => i.severity === "high").length;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-heading text-[17px] text-fg">Google policy</p>
          <p className="text-[13px] text-muted">
            {state === undefined
              ? "Reading…"
              : !state
                ? "Every disapproved or limited ad, asset and keyword, the exact trigger, Google's article and the fix, in one click."
                : running
                  ? `Checking the account, Google's policy articles and every landing page… (started ${ago(state.createdAt)})`
                  : state.status === "failed"
                    ? `The last check failed: ${state.error ?? "unknown error"}`
                    : `${state.summary ?? ""} Checked ${ago(state.finishedAt ?? state.createdAt)}.`}
          </p>
        </div>
        <button type="button" disabled={starting || running} onClick={run} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-brand px-5 text-[13.5px] font-medium text-white disabled:opacity-60 md:min-h-9">
          {running && <span className="size-2 animate-pulse rounded-full bg-white" />}
          {running ? "Checking…" : "Check everything"}
        </button>
      </div>
      {error && <p className="text-[13px] text-bad">{error}</p>}

      {state && !running && state.status === "done" && issues.length === 0 && <p className="rounded-[14px] border border-dashed border-line px-5 py-8 text-center text-sm text-muted">Nothing disapproved or limited. Clean account.</p>}

      {issues.length > 0 && (
        <>
          <div className="flex flex-wrap gap-2 text-[12px]">
            <span className="rounded-full bg-bad-soft px-2.5 py-1 text-bad">{high} disapproved</span>
            <span className="rounded-full bg-warn-soft px-2.5 py-1 text-warn">{issues.length - high} limited</span>
          </div>
          <ul className="grid gap-2">
            {issues.map((i) => {
              const isOpen = open === i.key;
              const trig = triggersOf(i);
              const sample = i.text.headlines.join(" | ") || i.text.keyword || i.text.asset || i.finalUrl || "";
              return (
                <li key={i.key} className={`overflow-hidden rounded-[16px] border bg-surface ${isOpen ? "border-fg/20" : "border-line"}`}>
                  <button type="button" onClick={() => pushParams({ [param]: isOpen ? null : i.key })} aria-expanded={isOpen} className="grid min-h-11 w-full gap-1 px-4 py-3 text-left hover:bg-surface-2">
                    <span className="flex items-center gap-2">
                      <span className={`size-2 shrink-0 rounded-full ${SEV[i.severity].dot}`} />
                      <span className="min-w-0 flex-1 truncate text-[14px] text-fg">{i.label}</span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${SEV[i.severity].chip}`}>{SEV[i.severity].word}</span>
                    </span>
                    <span className="truncate pl-4 text-[12px] text-faint">{[i.campaign, i.adGroup, i.topics.map((t) => t.topic.replace(/_/g, " ").toLowerCase()).join(", ")].filter(Boolean).join(" · ")}</span>
                    {sample && (
                      <span className="line-clamp-2 pl-4 text-[12.5px] text-muted">
                        <Marked text={sample} triggers={trig} />
                      </span>
                    )}
                  </button>
                  {isOpen && state && <IssueDetail issue={i} checkId={state.id} onApplied={load} />}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{title}</p>
      {children}
    </div>
  );
}

function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-fg hover:bg-surface-2 md:min-h-9"
    >
      {done ? "Copied" : label}
    </button>
  );
}

function IssueDetail({ issue, checkId, onApplied }: { issue: PolicyIssue; checkId: string; onApplied: () => void }) {
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [review, setReview] = useState<{ steps: string[]; appeal: string; link: string } | null>(null);
  const [pending, start] = useTransition();
  const ai = issue.ai;
  const trig = triggersOf(issue);
  const t = issue.text;
  const l = issue.landing;

  return (
    <div className="grid gap-5 border-t border-line bg-surface-2/40 px-4 py-4 text-[13.5px]">
      {(t.headlines.length > 0 || t.descriptions.length > 0 || t.keyword || t.asset) && (
        <Section title="As it runs now">
          <div className="grid gap-1 text-fg/90">
            {t.headlines.map((h, n) => (
              <p key={`h${n}`}>
                <Marked text={h} triggers={trig} />
              </p>
            ))}
            {t.descriptions.map((d, n) => (
              <p key={`d${n}`} className="text-muted">
                <Marked text={d} triggers={trig} />
              </p>
            ))}
            {t.keyword && <Marked text={t.keyword} triggers={trig} />}
            {t.asset && <Marked text={t.asset} triggers={trig} />}
          </div>
        </Section>
      )}

      <Section title="Google says">
        <ul className="grid gap-1">
          {issue.topics.map((p, n) => (
            <li key={n} className="text-fg/90">
              <span className="font-medium">{p.topic.replace(/_/g, " ").toLowerCase()}</span>
              {p.evidence.length > 0 && <span className="text-muted">: {p.evidence.join(" · ")}</span>}
            </li>
          ))}
        </ul>
      </Section>

      {ai ? (
        <>
          <Section title="What's wrong">
            <p className="text-fg">{ai.wrong}</p>
            <p className="text-muted">{ai.why}</p>
            {ai.quote && <blockquote className="border-l-2 border-brand pl-3 text-[13px] italic text-muted">&ldquo;{ai.quote}&rdquo;</blockquote>}
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
              {(ai.article ? [ai.article] : issue.articles.map((a) => a.url)).map((u) => (
                <a key={u} href={u} target="_blank" rel="noreferrer" className="text-brand-text underline-offset-4 hover:underline">
                  {issue.articles.find((a) => a.url === u)?.title ?? "Google's policy"} ↗
                </a>
              ))}
            </div>
          </Section>

          {l && (
            <Section title="The landing page">
              <p className="break-all text-muted">
                {l.redirects.length ? `${l.url} → ${l.redirects.join(" → ")}` : (l.finalUrl ?? l.url)}
              </p>
              <div className="flex flex-wrap gap-1.5 text-[12px]">
                <span className={`rounded-full px-2 py-0.5 ${l.status && l.status < 400 ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{l.status ?? "no answer"}</span>
                <span className={`rounded-full px-2 py-0.5 ${l.https ? "bg-ok-soft text-ok" : "bg-bad-soft text-bad"}`}>{l.https ? "HTTPS" : "Not HTTPS"}</span>
                <span className={`rounded-full px-2 py-0.5 ${l.privacy ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{l.privacy ? "Privacy policy" : "No privacy policy found"}</span>
                <span className={`rounded-full px-2 py-0.5 ${l.contact ? "bg-ok-soft text-ok" : "bg-warn-soft text-warn"}`}>{l.contact ? "Contact details" : "No contact details found"}</span>
                {l.ms != null && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">{(l.ms / 1000).toFixed(1)}s</span>}
              </div>
              {l.note && <p className="text-[12.5px] text-warn">{l.note}</p>}
            </Section>
          )}

          <Section title="The fix">
            {ai.fix.headlines.length > 0 && (
              <div className="grid gap-1 rounded-[12px] border border-line bg-surface px-3 py-2">
                {ai.fix.headlines.map((h, n) => (
                  <p key={n} className="flex justify-between gap-3 text-fg">
                    <span>{h}</span>
                    <span className="tabular shrink-0 text-[11px] text-faint">{h.length}/30</span>
                  </p>
                ))}
                {ai.fix.descriptions.map((d, n) => (
                  <p key={`d${n}`} className="flex justify-between gap-3 text-muted">
                    <span>{d}</span>
                    <span className="tabular shrink-0 text-[11px] text-faint">{d.length}/90</span>
                  </p>
                ))}
              </div>
            )}
            {ai.fix.keyword && <p className="text-fg">Keyword: {ai.fix.keyword}</p>}
            {ai.fix.assetText && <p className="text-fg">New text: {ai.fix.assetText}</p>}
            {ai.fix.page.length > 0 && (
              <ul className="grid list-disc gap-1 pl-5 text-fg/90">
                {ai.fix.page.map((p, n) => (
                  <li key={n}>{p}</li>
                ))}
              </ul>
            )}
            {ai.fix.kind === "none" && <p className="text-muted">Nothing on our side breaks the policy: appeal it.</p>}
          </Section>

          {issue.applied && <p className="rounded-[12px] bg-ok-soft px-3 py-2 text-[13px] text-ok">{issue.applied.result} ({issue.applied.by})</p>}

          <div className="flex flex-wrap gap-2">
            {!issue.applied && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await applyPolicyFixAction(checkId, issue.key).catch(() => ({ ok: false as const, error: "Something went wrong." }));
                    setResult(r);
                    if (r.ok && r.mode === "applied") onApplied();
                  })
                }
                className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13px] font-medium text-white disabled:opacity-60 md:min-h-9"
              >
                {pending ? "Working…" : "Apply the fix"}
              </button>
            )}
            {ai.appeal && <Copy text={ai.appeal} label="Copy the appeal" />}
            <button
              type="button"
              onClick={() => start(async () => setReview(await requestReviewAction(checkId, issue.key).catch(() => null)))}
              className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-fg hover:bg-surface-2 md:min-h-9"
            >
              Request review
            </button>
          </div>

          {result && (
            <div className="grid gap-1.5 rounded-[12px] border border-line bg-surface px-3 py-2 text-[13px]">
              {!result.ok ? (
                <p className="text-bad">{result.error}</p>
              ) : (
                <>
                  <p className={result.mode === "applied" ? "text-ok" : "text-fg"}>{result.note}</p>
                  {result.mode === "checklist" && (
                    <ol className="grid list-decimal gap-1 pl-5 text-muted">
                      {result.steps.map((s, n) => (
                        <li key={n}>{s}</li>
                      ))}
                    </ol>
                  )}
                </>
              )}
            </div>
          )}

          {ai.appeal && (
            <Section title="The appeal">
              <p className="whitespace-pre-wrap rounded-[12px] border border-line bg-surface px-3 py-2 text-muted">{ai.appeal}</p>
            </Section>
          )}

          {review && (
            <Section title="Request review">
              <ol className="grid list-decimal gap-1 pl-5 text-muted">
                {review.steps.map((s, n) => (
                  <li key={n}>{s}</li>
                ))}
              </ol>
              <a href={review.link} target="_blank" rel="noreferrer" className="w-fit text-[12.5px] text-brand-text underline-offset-4 hover:underline">
                Open the Policy manager ↗
              </a>
              <p className="text-[12px] text-faint">Google&rsquo;s API has no appeal call, so the review is requested in Google Ads with the appeal above.</p>
            </Section>
          )}
        </>
      ) : (
        <p className="text-muted">Not reviewed yet{issue.articles[0] ? "" : ": run the check again"}. {issue.articles.map((a) => a.url).join(" ")}</p>
      )}
    </div>
  );
}
