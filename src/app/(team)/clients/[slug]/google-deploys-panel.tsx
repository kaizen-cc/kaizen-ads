"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { Deploy, DeployPlan, Kw } from "@/lib/google-deploy";
import { decideDeploy, deployState, deployTargets, editDeploy, markDeployApplied, pushDeployAction, rewriteDeploy } from "../../ideas/google-actions";

// Google ideas taken to this client from Ideas › Google: copy, a campaign or keywords around a winner from another
// account. Each is approved, edited or declined like a suggested brief; approved, it's applied by hand from its
// checklist or (with Google writes on) pushed to Google Ads paused. The one in the address (?deploy=) opens.

const KIND: Record<Deploy["kind"], string> = { copy: "Ad copy", campaign: "Campaign", keywords: "Keywords" };
const STATUS: Record<Deploy["status"], { label: string; cls: string }> = {
  drafting: { label: "Writing…", cls: "bg-brand/15 text-brand-text" },
  open: { label: "To decide", cls: "bg-warn-soft text-warn" },
  approved: { label: "Approved · to apply", cls: "bg-ok-soft text-ok" },
  declined: { label: "Declined", cls: "bg-surface-2 text-faint" },
  applied: { label: "Applied", cls: "bg-ok-soft text-ok" },
  partial: { label: "Partly applied", cls: "bg-warn-soft text-warn" },
  failed: { label: "Needs a look", cls: "bg-bad-soft text-bad" },
};
const kwText = (k: Kw) => (k.match === "exact" ? `[${k.text}]` : k.match === "phrase" ? `"${k.text}"` : k.text);
const parseKw = (line: string): Kw | null => {
  const t = line.trim();
  if (!t) return null;
  if (/^\[.*\]$/.test(t)) return { text: t.slice(1, -1).trim(), match: "exact" };
  if (/^".*"$/.test(t)) return { text: t.slice(1, -1).trim(), match: "phrase" };
  return { text: t, match: "broad" };
};
const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function GoogleDeploysPanel({ deploys: initial, canAct }: { deploys: Deploy[]; canAct: boolean }) {
  const [deploys, setDeploys] = useState(initial);
  const openId = useParam("deploy");
  // Ones being written: asked again every few seconds until they're in
  useEffect(() => {
    const busy = deploys.filter((d) => d.status === "drafting");
    if (!busy.length) return;
    const t = setInterval(async () => {
      const fresh = await Promise.all(busy.map((d) => deployState(d.id)));
      setDeploys((cur) => cur.map((d) => fresh.find((f) => f?.id === d.id) ?? d));
    }, 4000);
    return () => clearInterval(t);
  }, [deploys]);
  const update = (d: Deploy) => setDeploys((cur) => cur.map((x) => (x.id === d.id ? d : x)));
  const order = (d: Deploy) => ["open", "drafting", "failed", "approved", "partial", "applied", "declined"].indexOf(d.status);
  const list = [...deploys].sort((a, b) => order(a) - order(b) || b.createdAt.localeCompare(a.createdAt));

  if (!list.length)
    return (
      <div className="grid gap-2 rounded-[20px] border border-dashed border-line px-5 py-10 text-center">
        <p className="font-heading text-lg">No Google ideas taken here yet</p>
        <p className="mx-auto max-w-md text-sm text-muted">
          In <a href="/ideas?line=google&tab=fame" className="text-brand-text underline-offset-2 hover:underline">Ideas › Google</a>, open a winning ad, keyword or search term and choose &ldquo;Use it on a client&rdquo;: copy, a campaign or keywords around it land here to approve.
        </p>
      </div>
    );
  return (
    <div className="grid gap-3">
      {list.map((d) => (
        <Item key={d.id} d={d} open={openId === d.id} canAct={canAct} onChange={update} />
      ))}
    </div>
  );
}

function Item({ d, open, canAct, onChange }: { d: Deploy; open: boolean; canAct: boolean; onChange: (d: Deploy) => void }) {
  const s = STATUS[d.status];
  return (
    <article className={`overflow-hidden rounded-[20px] border bg-surface transition-colors ${open ? "border-faint" : "border-line"}`}>
      <button type="button" onClick={() => (open ? closeParams("deploy") : pushParams({ deploy: d.id }))} className="flex min-h-14 w-full items-start gap-3 p-4 text-left md:p-5" aria-expanded={open}>
        <span className="grid min-w-0 flex-1 gap-1.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[#4285f4]/15 px-2.5 py-0.5 text-[11px] font-medium text-[#4285f4]">{KIND[d.kind]}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${s.cls}`}>{s.label}</span>
            <span className="text-[11px] text-faint">{new Date(d.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
          </span>
          <span className="font-heading text-[16px] leading-snug">{d.plan?.summary ?? (d.status === "drafting" ? "Writing it for this client…" : "From a Google winner")}</span>
          <span className="line-clamp-2 text-[12.5px] text-muted">
            From {d.idea.kind === "ad" ? "a winning ad" : d.idea.kind === "keyword" ? "a winning keyword" : "a winning search term"}: {d.idea.text}
          </span>
        </span>
        <span className={`mt-1 shrink-0 text-faint transition-transform ${open ? "rotate-180" : ""}`}>⌄</span>
      </button>
      {open && <Body d={d} canAct={canAct} onChange={onChange} />}
    </article>
  );
}

function Body({ d, canAct, onChange }: { d: Deploy; canAct: boolean; onChange: (d: Deploy) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit" | "decline" | "rewrite" | "push">("view");
  const [note, setNote] = useState("");
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Something went wrong.");
      const fresh = await deployState(d.id);
      if (fresh) onChange(fresh);
      setMode("view");
      setNote("");
      after?.();
      router.refresh();
    });

  if (d.status === "drafting")
    return (
      <div className="grid gap-2 border-t border-line px-4 py-5 md:px-5" aria-busy>
        <p className="flex items-center gap-2 text-[12px] text-faint">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" /> Writing it from their Bible, Google strategy and playbook…
        </p>
        {[88, 72, 80, 54].map((w) => (
          <span key={w} className="h-3 animate-pulse rounded bg-surface-2" style={{ width: `${w}%` }} />
        ))}
      </div>
    );

  return (
    <div className="grid gap-5 border-t border-line px-4 py-5 md:px-5">
      <div className="grid gap-1 rounded-[14px] border border-line/70 bg-bg/50 p-3.5">
        <span className="text-[10px] uppercase tracking-[0.14em] text-faint">The winner it&apos;s built on</span>
        <p className="text-[13px] [overflow-wrap:anywhere]">{d.idea.text}</p>
        <p className="text-[12px] text-ok">{d.idea.result}</p>
      </div>
      {d.error && <p className="rounded-[12px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{d.error}</p>}
      {d.plan && (mode === "edit" ? <Editor plan={d.plan} pending={pending} onCancel={() => setMode("view")} onSave={(p) => run(() => editDeploy(d.id, p))} /> : <Plan d={d} plan={d.plan} />)}
      {d.declineReason && <p className="text-[12.5px] text-muted">Declined: {d.declineReason}</p>}
      {d.applied?.results?.length ? (
        <ul className="grid gap-1.5">
          {d.applied.results.map((r, n) => (
            <li key={n} className={`flex gap-2 text-[12.5px] ${r.ok ? "text-ok" : "text-bad"}`}>
              <span>{r.ok ? "✓" : "✕"}</span>
              <span className="[overflow-wrap:anywhere]">
                {r.what}
                {r.error ? `: ${r.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {canAct && mode !== "edit" && (
        <div className="grid gap-3">
          {(mode === "decline" || mode === "rewrite") && (
            <div className="grid gap-2">
              <textarea
                data-chat
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                placeholder={mode === "decline" ? "Why not? It reads every reason next time" : "What to change, e.g. lead with the free estimate, more local"}
                className="w-full rounded-[14px] border border-line bg-bg px-3.5 py-2.5 text-[16px] outline-none focus:border-brand/60 md:text-sm"
              />
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={pending || !note.trim()} onClick={() => run(() => (mode === "decline" ? decideDeploy(d.id, "decline", note) : rewriteDeploy(d.id, note)))} className="min-h-11 rounded-full bg-fg px-5 text-sm text-bg disabled:opacity-50">
                  {mode === "decline" ? "Decline" : "Rewrite it"}
                </button>
                <button type="button" onClick={() => setMode("view")} className="min-h-11 rounded-full px-4 text-sm text-muted hover:text-fg">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {mode === "push" && <Push d={d} pending={pending} onPush={(t) => run(() => pushDeployAction(d.id, t))} onCancel={() => setMode("view")} />}
          {mode === "view" && (
            <div className="flex flex-wrap gap-2">
              {(d.status === "open" || (d.status === "failed" && !d.decidedAt)) && d.plan && (
                <>
                  <button type="button" disabled={pending} onClick={() => run(() => decideDeploy(d.id, "approve"))} className="min-h-11 rounded-full bg-ok px-5 text-sm font-medium text-white disabled:opacity-60">
                    Approve
                  </button>
                  <button type="button" onClick={() => setMode("edit")} className="min-h-11 rounded-full border border-line px-4 text-sm hover:border-faint">
                    Edit
                  </button>
                  <button type="button" onClick={() => setMode("rewrite")} className="min-h-11 rounded-full border border-line px-4 text-sm hover:border-faint">
                    Rewrite with a note
                  </button>
                  <button type="button" onClick={() => setMode("decline")} className="min-h-11 rounded-full px-4 text-sm text-muted hover:text-fg">
                    Decline
                  </button>
                </>
              )}
              {(d.status === "approved" || d.status === "partial" || (d.status === "failed" && d.decidedAt)) && d.plan && (
                <>
                  {d.kind !== "campaign" && (
                    <button type="button" onClick={() => setMode("push")} className="min-h-11 rounded-full bg-fg px-5 text-sm text-bg">
                      Push to Google Ads (paused)
                    </button>
                  )}
                  <button type="button" disabled={pending} onClick={() => run(() => markDeployApplied(d.id))} className="min-h-11 rounded-full border border-line px-4 text-sm hover:border-faint disabled:opacity-60">
                    I applied it by hand
                  </button>
                  <button type="button" onClick={() => setMode("edit")} className="min-h-11 rounded-full px-4 text-sm text-muted hover:text-fg">
                    Edit
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </div>
  );
}

function Chips({ items }: { items: Kw[] }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      {items.map((k, n) => (
        <span key={n} className="rounded-full border border-line bg-bg/60 px-2.5 py-1 text-[12px] [overflow-wrap:anywhere]">
          {kwText(k)}
        </span>
      ))}
    </span>
  );
}

const Label = ({ children }: { children: React.ReactNode }) => <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{children}</span>;

function Plan({ d, plan }: { d: Deploy; plan: DeployPlan }) {
  const domain = (() => {
    try {
      return plan.finalUrl ? new URL(plan.finalUrl).hostname.replace(/^www\./, "") : null;
    } catch {
      return null;
    }
  })();
  return (
    <div className="grid gap-5">
      <p className="text-[13.5px] leading-relaxed text-muted">{plan.why}</p>
      {plan.headlines.length > 0 && (
        <div className="grid gap-2">
          <Label>The ad, as Google shows it</Label>
          <div className="grid gap-1.5 rounded-[14px] border border-line/70 bg-bg/60 p-3.5">
            <span className="text-[11px] text-muted">
              <b className="text-fg">Sponsored</b> · {domain ?? "their site"}
              {[plan.path1, plan.path2].filter(Boolean).map((p) => ` › ${p}`)}
            </span>
            <span className="text-[17px] font-medium leading-snug text-[#7aa7ff]">{plan.headlines.slice(0, 3).map((h) => h.text).join(" | ")}</span>
            <span className="text-[13px] text-muted">{plan.descriptions.slice(0, 2).map((x) => x.text).join(" ")}</span>
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            <span className="grid content-start gap-1">
              <Label>Headlines · {plan.headlines.length}</Label>
              {plan.headlines.map((h, n) => (
                <span key={n} className="flex items-baseline justify-between gap-2 border-b border-line/60 py-1 text-[13px]">
                  <span className="[overflow-wrap:anywhere]">
                    {h.text}
                    {h.pin ? <span className="ml-1.5 rounded bg-surface-2 px-1 text-[10px] text-faint">pin {h.pin}</span> : null}
                  </span>
                  <span className={`tabular shrink-0 text-[11px] ${h.text.length > 30 ? "text-bad" : "text-faint"}`}>{h.text.length}/30</span>
                </span>
              ))}
            </span>
            <span className="grid content-start gap-1">
              <Label>Descriptions · {plan.descriptions.length}</Label>
              {plan.descriptions.map((x, n) => (
                <span key={n} className="flex items-baseline justify-between gap-2 border-b border-line/60 py-1 text-[13px]">
                  <span className="[overflow-wrap:anywhere]">
                    {x.text}
                    {x.pin ? <span className="ml-1.5 rounded bg-surface-2 px-1 text-[10px] text-faint">pin {x.pin}</span> : null}
                  </span>
                  <span className={`tabular shrink-0 text-[11px] ${x.text.length > 90 ? "text-bad" : "text-faint"}`}>{x.text.length}/90</span>
                </span>
              ))}
            </span>
          </div>
        </div>
      )}
      {d.kind === "campaign" && (plan.campaignName || plan.adGroups.length > 0) && (
        <div className="grid gap-2">
          <Label>Campaign · {plan.campaignName || "new"}</Label>
          {plan.adGroups.map((g, n) => (
            <div key={n} className="grid gap-1.5 rounded-[14px] border border-line/70 p-3">
              <span className="text-[13px] font-medium">{g.name}</span>
              <Chips items={g.keywords} />
            </div>
          ))}
        </div>
      )}
      {plan.keywords.length > 0 && (
        <div className="grid gap-2">
          <Label>Keywords to add · {plan.keywords.length}</Label>
          <Chips items={plan.keywords} />
        </div>
      )}
      {plan.negatives.length > 0 && (
        <div className="grid gap-2">
          <Label>Negatives · {plan.negatives.length}</Label>
          <Chips items={plan.negatives} />
        </div>
      )}
      {plan.finalUrl && (
        <p className="text-[12.5px] text-muted [overflow-wrap:anywhere]">
          Landing page:{" "}
          <a href={plan.finalUrl} target="_blank" rel="noreferrer" className="text-brand-text hover:underline">
            {plan.finalUrl}
          </a>
        </p>
      )}
      {plan.settings.length > 0 && (
        <div className="grid gap-1.5">
          <Label>Settings</Label>
          {plan.settings.map((x, n) => (
            <span key={n} className="text-[13px] text-muted">
              · {x}
            </span>
          ))}
        </div>
      )}
      {plan.checklist.length > 0 && (
        <div className="grid gap-1.5 rounded-[16px] border border-brand/25 bg-brand-soft p-4">
          <Label>To apply it</Label>
          <ol className="grid list-decimal gap-1 pl-5 text-[13px]">
            {plan.checklist.map((x, n) => (
              <li key={n}>{x}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/** The buyer's own edits: one line per headline (a leading "1|" pins it), description or keyword ([exact], "phrase", broad). */
function Editor({ plan, pending, onSave, onCancel }: { plan: DeployPlan; pending: boolean; onSave: (p: DeployPlan) => void; onCancel: () => void }) {
  const pinned = (t: string, pin: number) => (pin ? `${pin}|${t}` : t);
  const [heads, setHeads] = useState(plan.headlines.map((h) => pinned(h.text, h.pin)).join("\n"));
  const [descs, setDescs] = useState(plan.descriptions.map((x) => pinned(x.text, x.pin)).join("\n"));
  const [kws, setKws] = useState(plan.keywords.map(kwText).join("\n"));
  const [negs, setNegs] = useState(plan.negatives.map(kwText).join("\n"));
  const [url, setUrl] = useState(plan.finalUrl);
  const [p1, setP1] = useState(plan.path1);
  const [p2, setP2] = useState(plan.path2);
  const unpin = (l: string, max: number) => {
    const m = l.match(/^([1-3])\|(.*)$/);
    const pin = m ? Math.min(Number(m[1]), max) : 0;
    return { text: (m ? m[2] : l).trim(), pin };
  };
  const area = "w-full rounded-[14px] border border-line bg-bg px-3.5 py-2.5 font-mono text-[16px] outline-none focus:border-brand/60 md:text-[13px]";
  return (
    <div className="grid gap-3">
      {plan.headlines.length > 0 && (
        <label className="grid gap-1">
          <Label>Headlines, one a line (30 max; &ldquo;1|&rdquo; pins it first)</Label>
          <textarea rows={8} value={heads} onChange={(e) => setHeads(e.target.value)} className={area} />
        </label>
      )}
      {plan.descriptions.length > 0 && (
        <label className="grid gap-1">
          <Label>Descriptions, one a line (90 max)</Label>
          <textarea rows={4} value={descs} onChange={(e) => setDescs(e.target.value)} className={area} />
        </label>
      )}
      {(plan.headlines.length > 0 || plan.finalUrl) && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_120px]">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Landing page" className={area} />
          <input value={p1} onChange={(e) => setP1(e.target.value)} placeholder="Path 1" className={area} />
          <input value={p2} onChange={(e) => setP2(e.target.value)} placeholder="Path 2" className={area} />
        </div>
      )}
      {plan.keywords.length > 0 && (
        <label className="grid gap-1">
          <Label>Keywords, one a line: [exact], &ldquo;phrase&rdquo;, broad</Label>
          <textarea rows={6} value={kws} onChange={(e) => setKws(e.target.value)} className={area} />
        </label>
      )}
      {plan.negatives.length > 0 && (
        <label className="grid gap-1">
          <Label>Negatives</Label>
          <textarea rows={4} value={negs} onChange={(e) => setNegs(e.target.value)} className={area} />
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            onSave({
              ...plan,
              headlines: lines(heads).map((l) => unpin(l, 3) as DeployPlan["headlines"][number]),
              descriptions: lines(descs).map((l) => unpin(l, 2) as DeployPlan["descriptions"][number]),
              keywords: lines(kws).map(parseKw).filter((k): k is Kw => Boolean(k)),
              negatives: lines(negs).map(parseKw).filter((k): k is Kw => Boolean(k)),
              finalUrl: url.trim(),
              path1: p1.trim(),
              path2: p2.trim(),
            })
          }
          className="min-h-11 rounded-full bg-fg px-5 text-sm text-bg disabled:opacity-60"
        >
          Save
        </button>
        <button type="button" onClick={onCancel} className="min-h-11 rounded-full px-4 text-sm text-muted hover:text-fg">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Where it goes in Google Ads: the ad group (for the ad or keywords) and the campaign (for negatives). */
function Push({ d, pending, onPush, onCancel }: { d: Deploy; pending: boolean; onPush: (t: { campaignId: string | null; adGroupId: string | null; campaign: string | null; adGroup: string | null }) => void; onCancel: () => void }) {
  const [t, setT] = useState<Awaited<ReturnType<typeof deployTargets>> | null>(null);
  const [group, setGroup] = useState("");
  const [camp, setCamp] = useState("");
  useEffect(() => {
    let live = true;
    deployTargets(d.id).then((r) => live && setT(r));
    return () => {
      live = false;
    };
  }, [d.id]);
  if (!t) return <p className="text-[12.5px] text-faint">Reading their Google Ads account…</p>;
  if (!t.ok) return <p className="text-[12.5px] text-bad">{t.error}</p>;
  if (!t.writes)
    return (
      <div className="grid gap-2 rounded-[14px] border border-line bg-bg/50 p-3.5 text-[13px] text-muted">
        <p>Changes in Google Ads are switched off (an exec turns them on in Settings › Sync health). Until then, apply it by hand from the checklist above and mark it applied.</p>
        <button type="button" onClick={onCancel} className="min-h-11 justify-self-start rounded-full px-4 text-sm text-muted hover:text-fg">
          Back
        </button>
      </div>
    );
  const g = t.adGroups.find((x) => x.id === group) ?? null;
  const c = t.campaigns.find((x) => x.id === (camp || g?.campaignId)) ?? null;
  const sel = "h-11 w-full rounded-[12px] border border-line bg-bg px-3 text-[16px] outline-none focus:border-brand/60 md:text-sm";
  return (
    <div className="grid gap-3 rounded-[16px] border border-line bg-bg/50 p-4">
      <p className="text-[13px] text-muted">Everything goes in paused. Google checks it first; nothing changes if it refuses.</p>
      <label className="grid gap-1">
        <Label>{d.kind === "copy" ? "Ad group for the ad" : "Ad group for the keywords"}</Label>
        <select value={group} onChange={(e) => setGroup(e.target.value)} className={sel}>
          <option value="">Pick an ad group</option>
          {t.adGroups.map((x) => (
            <option key={x.id} value={x.id}>
              {x.campaign} › {x.name}
            </option>
          ))}
        </select>
      </label>
      {d.kind === "keywords" && (d.plan?.negatives.length ?? 0) > 0 && (
        <label className="grid gap-1">
          <Label>Campaign for the negatives</Label>
          <select value={camp || g?.campaignId || ""} onChange={(e) => setCamp(e.target.value)} className={sel}>
            <option value="">Leave the negatives out</option>
            {t.campaigns.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending || !group} onClick={() => onPush({ adGroupId: group || null, adGroup: g?.name ?? null, campaignId: d.kind === "keywords" ? (c?.id ?? null) : null, campaign: c?.name ?? null })} className="min-h-11 rounded-full bg-fg px-5 text-sm text-bg disabled:opacity-50">
          {pending ? "Sending…" : "Push it, paused"}
        </button>
        <button type="button" onClick={onCancel} className="min-h-11 rounded-full px-4 text-sm text-muted hover:text-fg">
          Cancel
        </button>
      </div>
    </div>
  );
}
