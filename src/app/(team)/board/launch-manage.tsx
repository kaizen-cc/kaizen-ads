"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { Delivery } from "@/lib/launch-manage";
import { eventLabel, firedAgo } from "@/lib/meta-events";
import { editLaunched, launchDelivery, switchDelivery, type LaunchView } from "./launch-actions";

// The launched ads, run from Kaizen Ads: what Meta shows for them now, turning them on (or pausing them), and editing
// what the launcher decided. Ads Manager stays one link away, but nothing here needs it.

const field = "w-full rounded-[10px] border border-line bg-bg px-3 text-sm text-fg outline-none transition-colors focus:border-[#0866ff]/60";
const label = "text-[11px] uppercase tracking-[0.14em] text-faint";

const STATE: Record<string, [string, string]> = {
  ACTIVE: ["On", "bg-ok/15 text-ok"],
  PAUSED: ["Paused", "bg-surface-3 text-muted"],
  ADSET_PAUSED: ["Ad set paused", "bg-warn/15 text-warn"],
  CAMPAIGN_PAUSED: ["Campaign paused", "bg-warn/15 text-warn"],
  PENDING_REVIEW: ["In review", "bg-[#0866ff]/15 text-[#7aa7ff]"],
  IN_PROCESS: ["Processing", "bg-[#0866ff]/15 text-[#7aa7ff]"],
  PREAPPROVED: ["Approved", "bg-ok/15 text-ok"],
  DISAPPROVED: ["Rejected", "bg-bad/15 text-bad"],
  WITH_ISSUES: ["Has issues", "bg-bad/15 text-bad"],
  ARCHIVED: ["Archived", "bg-surface-3 text-faint"],
  DELETED: ["Deleted", "bg-surface-3 text-faint"],
};
function Pill({ s }: { s: string }) {
  const [text, tone] = STATE[s] ?? [s.replace(/_/g, " ").toLowerCase(), "bg-surface-3 text-muted"];
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium ${tone}`}>{text}</span>;
}

const CTAS = ["SHOP_NOW", "LEARN_MORE", "SIGN_UP", "BOOK_NOW", "BOOK_TRAVEL", "ORDER_NOW", "GET_OFFER", "GET_QUOTE", "CONTACT_US", "CALL_NOW", "MESSAGE_PAGE", "APPLY_NOW", "SUBSCRIBE", "DOWNLOAD", "GET_STARTED", "SEE_MENU", "GET_DIRECTIONS", "REQUEST_TIME", "BUY_TICKETS", "WATCH_MORE", "LISTEN_NOW", "DONATE_NOW", "PLAY_GAME", "INSTALL_MOBILE_APP"];
const ctaLabel = (c: string) => c.replace(/_/g, " ").toLowerCase().replace(/^./, (x) => x.toUpperCase());

const ENH: Record<string, string> = {
  image_touchups: "Visual touch-ups",
  image_brightness_and_contrast: "Brightness and contrast",
  text_optimizations: "Text improvements",
  enhance_cta: "Enhance the button",
  image_templates: "Add overlays",
  image_uncrop: "Expand the image",
  adapt_to_placement: "Adapt to placement",
  video_auto_crop: "Video auto-crop",
  inline_comment: "Relevant comments",
  description_automation: "Auto descriptions",
  add_text_overlay: "Text overlay",
  image_animation: "Animate the image",
  music: "Add music",
  text_translation: "Translate the text",
  site_extensions: "Site links",
  product_extensions: "Product extensions",
};

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** A list of texts (primary texts, headlines, descriptions): up to five, each editable and removable. */
function Texts({ title, items, onChange, max, rows, keep }: { title: string; items: string[]; onChange: (x: string[]) => void; max: number; rows: number; keep: number }) {
  return (
    <div className="grid gap-2">
      <p className={label}>
        {title} <span className="normal-case tracking-normal">· {items.length} of 5</span>
      </p>
      {items.map((t, i) => (
        <div key={i} className="relative">
          <textarea
            value={t}
            rows={rows}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
            className={`${field} resize-y py-2.5 pr-10 leading-relaxed`}
          />
          <span className={`pointer-events-none absolute bottom-2 right-3 text-[10px] tabular ${t.length > max ? "text-warn" : "text-faint"}`}>{t.length}</span>
          {items.length > keep && (
            <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label={`Remove ${title.toLowerCase()} ${i + 1}`} className="absolute right-1 top-1 grid h-9 w-9 place-items-center rounded-full text-faint hover:text-fg">
              ×
            </button>
          )}
        </div>
      ))}
      {items.length < 5 && (
        <button type="button" onClick={() => onChange([...items, ""])} className="justify-self-start rounded-full border border-dashed border-line px-3.5 py-1.5 text-xs text-muted hover:text-fg max-md:min-h-11">
          + Add {title.toLowerCase().replace(/s$/, "")}
        </button>
      )}
    </div>
  );
}

export function LaunchManage({ l, onDone }: { l: LaunchView; onDone: () => void }) {
  const p = l.plan!;
  const [d, setD] = useState<Delivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<null | { target: "ads" | "adset" | "campaign"; on: boolean }>(null);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const refresh = useCallback(async () => setD(await launchDelivery(l.id)), [l.id]);
  useEffect(() => {
    const first = setTimeout(refresh, 0);
    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(first);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  // The editor, from what's live now
  const blank = () => ({
    names: Object.fromEntries((l.result?.ads ?? []).filter((a) => a.adId).map((a) => [a.designId, a.name])),
    bodies: [...p.copy.bodies],
    titles: [...p.copy.titles],
    descriptions: [...p.copy.descriptions],
    cta: p.cta,
    link: p.link ?? "",
    urlTags: p.urlTags ?? "",
    pageId: p.pageId ?? "",
    igId: p.igId,
    optOut: [...p.optOut],
    trackingPixel: p.trackingPixel ?? "",
    leadFormId: p.leadFormId ?? "",
    budget: "" as string,
    reason: "",
  });
  const [f, setF] = useState(blank);
  const set = <K extends keyof ReturnType<typeof blank>>(k: K, v: ReturnType<typeof blank>[K]) => setF((x) => ({ ...x, [k]: v }));
  const known = p.known ?? p.optOut;

  const switchIt = (target: "ads" | "adset" | "campaign", on: boolean) =>
    start(async () => {
      setError(null);
      setAsk(null);
      const r = await switchDelivery(l.id, target, on);
      if (!r.ok) return setError(r.error);
      setD(r.delivery);
      onDone();
    });

  const save = () =>
    start(async () => {
      setError(null);
      setSaved(null);
      const budget = f.budget.trim() ? Number(f.budget) : null;
      const r = await editLaunched(
        l.id,
        {
          names: f.names,
          copy: { bodies: f.bodies, titles: f.titles, descriptions: f.descriptions },
          cta: f.cta,
          link: f.link,
          urlTags: f.urlTags || null,
          pageId: f.pageId || undefined,
          igId: f.igId,
          optOut: f.optOut,
          trackingPixel: f.trackingPixel || null,
          leadFormId: f.leadFormId || undefined,
          dailyBudget: budget,
        },
        f.reason,
      );
      if (!r.ok) return setError(r.error);
      setSaved(`Saved to Meta: ${r.changes.join(", ")}.`);
      setEditing(false);
      onDone();
      void refresh();
    });

  const paused = d?.ads.filter((a) => a.status !== "ACTIVE") ?? [];
  const budgetNow = d ? (d.budget === "campaign" ? d.campaign?.daily : d.budget === "adset" ? d.adset?.daily : null) : null;
  const parentOff = d && ((d.adset && d.adset.status !== "ACTIVE") || (d.campaign && d.campaign.status !== "ACTIVE"));

  return (
    <div className="relative grid gap-4">
      {/* Live in Meta */}
      <div className="grid gap-1.5">
        {(d?.ads ?? l.result!.ads.filter((a) => a.adId).map((a) => ({ adId: a.adId!, designId: a.designId, name: a.name, status: "", effective: "", issue: null as string | null }))).map((a) => (
          <div key={a.adId} className="grid gap-1 rounded-[12px] border border-line bg-bg/40 px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{a.name}</span>
              {a.effective ? <Pill s={a.effective} /> : <span className="h-5 w-16 animate-pulse rounded-full bg-surface-2" />}
            </div>
            {a.issue && <p className="text-xs text-bad">{a.issue}</p>}
          </div>
        ))}
        {d && (d.adset || d.campaign) && (
          <div className="grid gap-1 px-1 pt-1 text-xs text-faint">
            {[
              ["adset", "Ad set", d.adset],
              ["campaign", "Campaign", d.campaign],
            ].map(([key, name, x]) => {
              const o = x as Delivery["adset"];
              if (!o) return null;
              const daily = key === d.budget ? o.daily : null;
              return (
                <div key={key as string} className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-faint">{name as string}</span>
                  <span className="min-w-0 truncate text-muted">{o.name}</span>
                  {daily != null && <span className="tabular text-muted">· {money(daily)}/day</span>}
                  {key === "adset" && d.adset?.pixel && (
                    <span className="text-muted">
                      · optimizes for {eventLabel(d.adset.event ?? d.adset.optimization ?? "?")} on {p.options.pixels?.find((x) => x.id === d.adset!.pixel)?.name ?? d.adset.pixel}
                    </span>
                  )}
                  <Pill s={o.status === "ACTIVE" ? "ACTIVE" : "PAUSED"} />
                  {o.status !== "ACTIVE" && !l.sandbox && l.canLaunch && (
                    <button type="button" onClick={() => setAsk({ target: key as "adset" | "campaign", on: true })} className="text-[#7aa7ff] hover:underline max-md:min-h-11 max-md:px-1">
                      Turn on
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Turning it on, with what that means */}
      {ask ? (
        <div className="grid gap-3 rounded-[14px] border border-[#0866ff]/40 bg-[#0866ff]/[0.08] p-4">
          <p className="text-sm leading-relaxed">
            {ask.on
              ? ask.target === "ads"
                ? `Turn on ${paused.length === 1 ? "this ad" : `these ${paused.length} ads`} in the client's account?${budgetNow ? ` They spend from the ${d?.budget === "campaign" ? "campaign" : "ad set"} budget of ${money(budgetNow)}/day.` : ""}`
                : `Turn on the ${ask.target === "adset" ? "ad set" : "campaign"}? Every ad in it that's on starts spending, not only these.`
              : `Pause ${d?.ads.length === 1 ? "this ad" : "these ads"}?`}
            {ask.on && ask.target === "ads" && parentOff ? " Its ad set or campaign is paused too, so it won't deliver until that's on." : ""}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => switchIt(ask.target, ask.on)} disabled={pending} className="h-10 rounded-full bg-[#0866ff] px-5 text-sm font-medium text-white disabled:opacity-60 max-md:h-12 max-md:flex-1">
              {pending ? "Telling Meta…" : ask.on ? "Yes, turn it on" : "Yes, pause"}
            </button>
            <button type="button" onClick={() => setAsk(null)} className="h-10 px-3 text-sm text-faint hover:text-fg max-md:h-12">
              Not yet
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {l.canLaunch && d && paused.length > 0 && !l.sandbox && (
            <button type="button" onClick={() => setAsk({ target: "ads", on: true })} className="h-10 rounded-full bg-[#0866ff] px-5 text-sm font-medium text-white shadow-[0_10px_30px_-12px_rgba(8,102,255,0.9)] hover:brightness-110 max-md:h-12 max-md:w-full">
              Turn on {paused.length === 1 ? "the ad" : `${paused.length} ads`}
            </button>
          )}
          {l.canLaunch && d && d.ads.length > 0 && paused.length === 0 && (
            <button type="button" onClick={() => setAsk({ target: "ads", on: false })} className="h-10 rounded-full border border-line px-5 text-sm text-muted hover:text-fg max-md:h-12 max-md:w-full">
              Pause
            </button>
          )}
          {l.canLaunch && (
            <button
              type="button"
              onClick={() => {
                setF(blank());
                setEditing((e) => !e);
                setSaved(null);
              }}
              className={`h-10 rounded-full px-5 text-sm font-medium max-md:h-12 max-md:flex-1 ${editing ? "bg-fg text-bg" : "border border-line text-fg hover:bg-surface-2"}`}
            >
              {editing ? "Close the editor" : "Edit the ad"}
            </button>
          )}
          {l.result?.link && (
            <a href={l.result.link} target="_blank" rel="noreferrer" className="px-2 text-xs text-faint hover:text-fg max-md:grid max-md:min-h-11 max-md:place-items-center">
              Ads Manager ↗
            </a>
          )}
        </div>
      )}
      {l.sandbox && <p className="text-xs text-faint">A sandbox test stays paused (it would spend Kaizen&apos;s money on a client&apos;s creative), but everything else here works on it.</p>}
      {saved && <p className="text-sm text-ok">✓ {saved}</p>}
      {error && <p className="rounded-[10px] bg-bad/10 px-3 py-2 text-sm text-bad">{error}</p>}

      {/* The editor */}
      {editing && (
        <div className="grid gap-5 rounded-[16px] border border-line bg-bg/50 p-4 max-md:p-3.5" style={{ animation: "fade-in-late .2s ease-out" }}>
          <div className="grid gap-2">
            <p className={label}>Ad names</p>
            {(l.result?.ads ?? [])
              .filter((a) => a.adId)
              .map((a) => (
                <input key={a.designId} value={f.names[a.designId] ?? a.name} onChange={(e) => set("names", { ...f.names, [a.designId]: e.target.value })} className={`${field} h-10 max-md:h-11`} aria-label={`Name of ${a.name}`} />
              ))}
          </div>

          <Texts title="Primary texts" items={f.bodies} onChange={(x) => set("bodies", x)} max={125} rows={3} keep={1} />
          <Texts title="Headlines" items={f.titles} onChange={(x) => set("titles", x)} max={40} rows={1} keep={1} />
          <Texts title="Descriptions" items={f.descriptions} onChange={(x) => set("descriptions", x)} max={30} rows={1} keep={0} />

          <div className="grid gap-3 sm:grid-cols-2">
            <label className={`grid gap-1 ${label}`}>
              Button
              <select value={f.cta} onChange={(e) => set("cta", e.target.value)} className={`${field} h-10 normal-case tracking-normal max-md:h-11`}>
                {[...new Set([f.cta, ...CTAS])].map((c) => (
                  <option key={c} value={c}>
                    {ctaLabel(c)}
                  </option>
                ))}
              </select>
            </label>
            <label className={`grid gap-1 ${label}`}>
              Daily budget {d?.budget === "campaign" ? "· campaign" : d?.budget === "adset" ? "· ad set" : ""}
              {d?.budget === "lifetime" ? (
                <span className="normal-case tracking-normal text-muted">A lifetime budget: change it in Ads Manager.</span>
              ) : (
                <span className="flex h-10 items-center gap-1.5 rounded-[10px] border border-line bg-bg px-3 text-sm normal-case tracking-normal focus-within:border-[#0866ff]/60 max-md:h-11">
                  <span className="text-faint">$</span>
                  <input inputMode="decimal" value={f.budget} onChange={(e) => set("budget", e.target.value.replace(/[^\d.]/g, ""))} placeholder={budgetNow != null ? `${budgetNow} now` : "Unchanged"} className="h-full min-w-0 flex-1 bg-transparent tabular text-fg outline-none placeholder:text-faint" />
                  <span className="text-xs text-faint">/day</span>
                </span>
              )}
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className={`grid gap-1 ${label}`}>
              Link
              <input value={f.link} onChange={(e) => set("link", e.target.value)} placeholder="https://" className={`${field} h-10 normal-case tracking-normal max-md:h-11`} />
            </label>
            <label className={`grid gap-1 ${label}`}>
              URL parameters
              <input value={f.urlTags} onChange={(e) => set("urlTags", e.target.value)} placeholder="utm_source=facebook&utm_medium=paid" className={`${field} h-10 normal-case tracking-normal max-md:h-11`} />
            </label>
          </div>

          {p.options.pages.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={`grid gap-1 ${label}`}>
                Facebook Page
                <select value={f.pageId} onChange={(e) => set("pageId", e.target.value)} className={`${field} h-10 normal-case tracking-normal max-md:h-11`}>
                  {p.options.pages.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`grid gap-1 ${label}`}>
                Instagram
                <select value={f.igId ?? ""} onChange={(e) => set("igId", e.target.value || null)} className={`${field} h-10 normal-case tracking-normal max-md:h-11`}>
                  <option value="">Use the Facebook Page</option>
                  {p.options.igs.map((x) => (
                    <option key={x.id} value={x.id}>
                      @{x.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}

          {p.leadFormId && (p.options.leadForms?.length ?? 0) > 0 && (
            <label className={`grid gap-1 ${label}`}>
              Instant form
              <select value={f.leadFormId} onChange={(e) => set("leadFormId", e.target.value)} className={`${field} h-10 normal-case tracking-normal max-md:h-11`}>
                {p.options.leadForms!.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className={`grid gap-1 ${label}`}>
            Website events dataset
            <select value={f.trackingPixel} onChange={(e) => set("trackingPixel", e.target.value)} className={`${field} h-10 normal-case tracking-normal max-md:h-11`}>
              <option value="">Meta&apos;s default</option>
              {(p.options.pixels ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} · {firedAgo(x.lastFired)}
                </option>
              ))}
            </select>
            <span className="normal-case tracking-normal text-faint">What the ad set optimizes for stays as it is; Meta doesn&apos;t let that change once an ad set has run.</span>
          </label>

          {known.length > 0 && (
            <div className="grid gap-2">
              <p className={label}>
                Advantage+ enhancements <span className="normal-case tracking-normal">· off keeps the ad exactly as the client approved it</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                {known.map((k) => {
                  const on = !f.optOut.includes(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      aria-pressed={on}
                      onClick={() => set("optOut", on ? [...f.optOut, k] : f.optOut.filter((x) => x !== k))}
                      className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-xs transition-colors max-md:h-11 max-md:px-4 ${on ? "bg-[#0866ff]/20 text-[#a9c6ff] ring-1 ring-[#0866ff]/50" : "border border-line text-muted hover:text-fg"}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${on ? "bg-[#7aa7ff]" : "bg-faint/50"}`} />
                      {ENH[k] ?? k.replace(/_/g, " ")}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <label className={`grid gap-1 ${label}`}>
            Why the change? <span className="normal-case tracking-normal">Optional: the launcher learns it for this client</span>
            <input value={f.reason} onChange={(e) => set("reason", e.target.value)} placeholder="e.g. This client's offers convert better with Book now" className={`${field} h-10 normal-case tracking-normal max-md:h-11`} />
          </label>

          <div className="grid gap-2 border-t border-line pt-4">
            <p className="text-xs leading-relaxed text-faint">
              Kaizen Ads checks it with Meta first, so nothing changes if Meta would refuse it. New text or settings go into the same {l.result!.ads.filter((x) => x.adId).length === 1 ? "ad" : "ads"} (same ID and history); an ad that&apos;s on goes back through Meta&apos;s review. The copy the client approved stays as it was on the ticket.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={save} disabled={pending} className="h-10 rounded-full bg-fg px-5 text-sm font-medium text-bg disabled:opacity-60 max-md:h-12 max-md:flex-1">
                {pending ? "Checking with Meta…" : "Save to Meta"}
              </button>
              <button type="button" onClick={() => setEditing(false)} className="h-10 px-3 text-sm text-faint hover:text-fg max-md:h-12">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {l.edits.length > 0 && !editing && (
        <ul className="grid gap-1 text-xs text-faint">
          {l.edits.slice(-3).map((e) => (
            <li key={e.at}>
              Edited {new Date(e.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}: {e.changes.join(", ")}
              {e.reason ? ` · ${e.reason}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
