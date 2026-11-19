"use client";

import { useEffect, useState } from "react";
import { closeParams, pushParams, useParam } from "@/lib/url-state";
import type { CampaignPreview } from "@/lib/klaviyo/store";
import { klaviyoCampaignPreview } from "./klaviyo-actions";
import { Layer } from "./layer";

// A campaign as it was sent: the email itself (its HTML from Klaviyo, made safe on the server and shown in a sandboxed
// frame that can't run scripts or reach the page; images load) scaled down in the hover card, or the SMS in a phone
// bubble. "Open full preview" opens it full size in a sheet that lives in the address (?epreview=), so back closes it.

const cache = new Map<string, Promise<{ ok: true; preview: CampaignPreview } | { ok: false; error: string }>>();
function load(clientId: string, campaignId: string) {
  const k = `${clientId}:${campaignId}`;
  let p = cache.get(k);
  if (!p) {
    p = klaviyoCampaignPreview(clientId, campaignId).catch(() => ({ ok: false as const, error: "The preview couldn't be loaded." }));
    cache.set(k, p);
    // A failure can be tried again on the next hover
    void p.then((r) => !r.ok && cache.delete(k));
  }
  return p;
}

function usePreview(clientId: string, campaignId: string | null) {
  const [state, setState] = useState<{ id: string; preview: CampaignPreview | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!campaignId) return;
    let live = true;
    void load(clientId, campaignId).then((r) => live && setState({ id: campaignId, preview: r.ok ? r.preview : null, error: r.ok ? null : r.error }));
    return () => {
      live = false;
    };
  }, [clientId, campaignId]);
  return state && state.id === campaignId ? state : null;
}

/** The email in a frame that runs nothing: no scripts, no same-origin, links open a new tab */
function EmailFrame({ html, title, scale = 1, height }: { html: string; title: string; scale?: number; height: number }) {
  const w = 600;
  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-white" style={{ width: w * scale, height }}>
      <iframe title={title} srcDoc={html} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" loading="lazy" className="block border-0" style={{ width: w, height: height / scale, transform: `scale(${scale})`, transformOrigin: "0 0" }} />
    </div>
  );
}

function SmsBubble({ text }: { text: string }) {
  return (
    <div className="mx-auto grid w-full max-w-[300px] gap-2 rounded-[28px] border border-line bg-surface-2 p-4">
      <span className="mx-auto h-1 w-12 rounded-full bg-line" aria-hidden />
      <p className="w-fit max-w-[88%] whitespace-pre-wrap rounded-[18px] rounded-bl-[6px] bg-surface px-3.5 py-2.5 text-[13px] leading-snug text-fg [overflow-wrap:anywhere]">{text}</p>
    </div>
  );
}

const Skeleton = ({ h }: { h: number }) => <div className="animate-pulse rounded-[10px] bg-surface-2" style={{ height: h }} aria-label="Loading the preview" />;

/** The hover card's content: subject and preview text, the email scaled down (or the SMS), and the full preview button */
export function CampaignPreviewCard({ clientId, campaign }: { clientId: string; campaign: { id: string; name: string; channel: string; subject: string | null; previewText: string | null } }) {
  const s = usePreview(clientId, campaign.id);
  const sms = campaign.channel === "sms" || s?.preview?.channel === "sms";
  return (
    <div className="grid gap-2.5">
      <div className="grid gap-0.5">
        <span className="text-[10.5px] uppercase tracking-[0.12em] text-faint">{sms ? "SMS" : "Email"} · {campaign.name}</span>
        {!sms && <span className="text-[13.5px] font-medium leading-snug">{s?.preview?.subject ?? campaign.subject ?? "No subject line"}</span>}
        {!sms && (s?.preview?.previewText ?? campaign.previewText) && <span className="text-[12px] text-muted">{s?.preview?.previewText ?? campaign.previewText}</span>}
      </div>
      {!s ? (
        <Skeleton h={sms ? 120 : 380} />
      ) : s.error ? (
        <p className="rounded-[10px] border border-line px-3 py-2 text-[12px] text-faint">{s.error}</p>
      ) : s.preview?.html ? (
        <EmailFrame html={s.preview.html} title={`Preview of ${campaign.name}`} scale={0.56} height={380} />
      ) : s.preview?.body ? (
        <SmsBubble text={s.preview.body} />
      ) : null}
      {s?.preview && (
        <button type="button" onClick={() => pushParams({ epreview: campaign.id })} className="flex min-h-11 items-center justify-center rounded-full border border-line text-[13px] font-medium text-fg transition-colors hover:bg-surface-2">
          Open full preview
        </button>
      )}
    </div>
  );
}

/** The full-size preview sheet (?epreview=<campaign id>) */
export function CampaignPreviewSheet({ clientId, campaigns }: { clientId: string; campaigns: { id: string; name: string; channel: string; subject: string | null; previewText: string | null; sendTime: string | null }[] }) {
  const id = useParam("epreview");
  const c = id ? campaigns.find((x) => x.id === id) ?? null : null;
  const s = usePreview(clientId, c?.id ?? null);
  useEffect(() => {
    if (!c) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeParams("epreview");
    window.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [c]);
  if (!c) return null;
  const sms = c.channel === "sms" || s?.preview?.channel === "sms";
  // On <body> (Layer): inside the page's tab panel a fixed box is placed against the panel's animation, not the screen
  return (
    <Layer>
      <div className="fixed inset-0 z-[130] grid grid-rows-[auto_minmax(0,1fr)] bg-deep-2 text-fg" role="dialog" aria-modal="true" aria-label={`Preview of ${c.name}`} style={{ animation: "epv-in .2s ease-out" }}>
        <style>{`@keyframes epv-in { from { transform: translateY(16px); opacity: 0 } to { transform: none; opacity: 1 } }`}</style>
        <div className="flex items-start gap-3 border-b border-ink/10 px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
          <div className="mx-auto flex w-full max-w-[760px] items-start gap-3">
            <div className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-[11px] uppercase tracking-[0.12em] text-faint">
                {sms ? "SMS" : "Email"}
                {c.sendTime ? ` · sent ${new Date(c.sendTime).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" })}` : ""}
              </span>
              <span className="truncate text-[15px] font-medium">{sms ? c.name : (s?.preview?.subject ?? c.subject ?? c.name)}</span>
              {!sms && (s?.preview?.previewText ?? c.previewText) && <span className="truncate text-[12.5px] text-muted">{s?.preview?.previewText ?? c.previewText}</span>}
            </div>
            <button type="button" onClick={() => closeParams("epreview")} aria-label="Close preview" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-ink/10 text-ink/70 hover:bg-ink/10">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain bg-surface-2/40 px-0 pb-[env(safe-area-inset-bottom)] md:px-4 md:py-4">
          {!s ? (
            <div className="mx-auto max-w-[640px] p-3">
              <Skeleton h={480} />
            </div>
          ) : s.error ? (
            <p className="p-4 text-sm text-faint">{s.error}</p>
          ) : s.preview?.html ? (
            // The email scrolls inside its own frame (it can't be measured from outside a sandbox), filling the screen under the header
            <iframe title={`Preview of ${c.name}`} srcDoc={s.preview.html} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="mx-auto block h-full min-h-[60vh] w-full max-w-[640px] border-0 bg-white md:rounded-[10px]" />
          ) : s.preview?.body ? (
            <div className="py-8">
              <SmsBubble text={s.preview.body} />
            </div>
          ) : null}
        </div>
      </div>
    </Layer>
  );
}
