"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { fillReadiness, setClientService } from "./[slug]/actions";
import { SERVICES, type ServiceSlug } from "@/lib/services";
import { Layer } from "./[slug]/layer";

// A connection a client card is missing (their Slack channel, the internal one, the Drive folder), named on the card
// even folded. Pointing at it opens a little field to paste the ID (or the folder link) and connect it right there.

export type MissingLink = "slack_channel_id" | "internal_slack_channel_id" | "drive_folder_id";

const LINK: Record<MissingLink, { label: string; field: string; placeholder: string; how: string; check: (v: string) => string | null }> = {
  slack_channel_id: {
    label: "Client Slack",
    field: "Client Slack channel ID",
    placeholder: "C04ABC123",
    how: "In Slack, open the shared channel's details: the ID is at the very bottom.",
    check: (v) => (/^[CG][A-Z0-9]{6,}$/.test(v) ? null : "A channel ID starts with C and is letters and numbers, like C04ABC123."),
  },
  internal_slack_channel_id: {
    label: "Internal Slack",
    field: "Internal Slack channel ID",
    placeholder: "C04ABC123",
    how: "The team's own channel for this client: its ID is at the bottom of the channel details.",
    check: (v) => (/^[CG][A-Z0-9]{6,}$/.test(v) ? null : "A channel ID starts with C and is letters and numbers, like C04ABC123."),
  },
  drive_folder_id: {
    label: "Drive",
    field: "Drive folder",
    placeholder: "Paste the folder link",
    how: "The client's folder in Google Drive: copy its link from the address bar.",
    check: (v) => (/folders\/[\w-]+/.test(v) || /^[\w-]{20,}$/.test(v) ? null : "Paste the folder's link (drive.google.com/drive/folders/…)."),
  },
};

export function MissingLinks({ clientId, slug, missing, canEdit }: { clientId: string; slug: string; missing: MissingLink[]; canEdit: boolean }) {
  if (!missing.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 normal-case" data-no-open>
      <span className="text-warn">·</span>
      {missing.map((k) => (
        <LinkFix key={k} clientId={clientId} slug={slug} link={k} canEdit={canEdit} />
      ))}
    </span>
  );
}

function LinkFix({ clientId, slug, link, canEdit }: { clientId: string; slug: string; link: MissingLink; canEdit: boolean }) {
  const L = LINK[link];
  const router = useRouter();
  const [at, setAt] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const typing = useRef(false);
  const keep = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  // Leaving closes it a moment later, unless something's being typed in it
  const leave = () => {
    keep();
    if (!typing.current) timer.current = setTimeout(() => setAt(null), 200);
  };
  const show = (el: HTMLElement) => {
    keep();
    const b = el.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 24);
    const up = b.top > window.innerHeight * 0.6;
    setAt({ x: Math.max(12, Math.min(b.left - 12, window.innerWidth - w - 12)), y: up ? b.top - 6 : b.bottom + 6, up });
  };
  const close = () => {
    typing.current = false;
    setAt(null);
  };
  const save = () => {
    const v = value.trim();
    const bad = L.check(v);
    if (bad) return setError(bad);
    setError(null);
    start(async () => {
      const form = new FormData();
      form.set(link, v);
      const r = await fillReadiness(clientId, slug, form);
      if (!r.ok) return setError(r.error);
      setDone(true);
      typing.current = false;
      setTimeout(() => {
        setAt(null);
        router.refresh();
      }, 900);
    });
  };

  return (
    <span onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={leave}>
      <button
        type="button"
        onClick={(e) => (at ? close() : show(e.currentTarget.parentElement!))}
        className="inline-flex min-h-8 items-center gap-1 rounded-full border border-dashed border-warn/50 px-2 text-[11px] text-warn transition-colors hover:border-warn hover:bg-warn-soft md:min-h-0 md:py-px"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
          <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
        </svg>
        No {L.label}
      </button>
      {at && (
        <Layer>
          <div
            role="dialog"
            aria-label={`Connect ${L.field}`}
            onMouseEnter={keep}
            onMouseLeave={leave}
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[80] w-[min(300px,calc(100vw-24px))]"
            style={{ left: at.x, top: at.y, transform: at.up ? "translateY(-100%)" : undefined, padding: at.up ? "0 0 6px" : "6px 0 0", margin: at.up ? "0 0 -6px" : "-6px 0 0" }}
          >
            <div className="grid gap-2.5 rounded-[14px] border border-line bg-surface/95 p-3.5 text-left text-xs shadow-[0_24px_60px_-24px_rgba(0,0,0,0.85)] backdrop-blur" style={{ animation: "fadeIn .15s ease-out" }}>
              {done ? (
                <span className="flex items-center gap-2 py-1 text-sm text-ok">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden>
                    <path d="M5 12.5l4.5 4.5L19 7" />
                  </svg>
                  {L.label} connected
                </span>
              ) : (
                <>
                  <span className="font-heading text-[13px]">Connect {L.field.toLowerCase()}</span>
                  <span className="leading-snug text-muted">{L.how}</span>
                  {canEdit ? (
                    <form
                      className="grid gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        save();
                      }}
                    >
                      <input
                        autoFocus
                        value={value}
                        onChange={(e) => {
                          typing.current = true;
                          setValue(e.target.value);
                          setError(null);
                        }}
                        onKeyDown={(e) => e.key === "Escape" && close()}
                        placeholder={L.placeholder}
                        aria-label={L.field}
                        className="h-11 rounded-[10px] border border-line bg-bg px-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-faint md:h-9"
                      />
                      {error && <span className="text-bad">{error}</span>}
                      <span className="flex items-center justify-between gap-2">
                        <button type="button" onClick={close} className="h-11 px-1 text-faint hover:text-fg md:h-8">
                          Cancel
                        </button>
                        <button type="submit" disabled={busy || !value.trim()} className="h-11 rounded-full bg-fg px-4 text-xs text-bg transition-opacity disabled:opacity-40 md:h-8">
                          {busy ? "Connecting…" : "Connect"}
                        </button>
                      </span>
                    </form>
                  ) : (
                    <span className="text-faint">An exec or lead can connect it.</span>
                  )}
                </>
              )}
            </div>
          </div>
        </Layer>
      )}
    </span>
  );
}

/**
 * "No services on file" on a card: pointing at it lists every service to tick on the spot (each saves as it's
 * picked, the same as adding it on the client's page).
 */
export function AddServices({ clientId, slug, canEdit, onAdded }: { clientId: string; slug: string; canEdit: boolean; onAdded: (s: ServiceSlug) => void }) {
  const router = useRouter();
  const [at, setAt] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const [picked, setPicked] = useState<ServiceSlug[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = () => {
    if (timer.current) clearTimeout(timer.current);
  };
  const leave = () => {
    keep();
    timer.current = setTimeout(() => setAt(null), 220);
  };
  const show = (el: HTMLElement) => {
    keep();
    const b = el.getBoundingClientRect();
    const w = Math.min(320, window.innerWidth - 24);
    const up = b.top > window.innerHeight * 0.6;
    setAt({ x: Math.max(12, Math.min(b.left, window.innerWidth - w - 12)), y: up ? b.top - 6 : b.bottom + 6, up });
  };
  const add = (s: ServiceSlug) => {
    if (picked.includes(s)) return;
    setPicked((p) => [...p, s]);
    setError(null);
    start(async () => {
      const r = await setClientService(clientId, slug, s, true);
      if (!r.ok) {
        setPicked((p) => p.filter((x) => x !== s));
        return setError(r.error);
      }
    });
  };
  // The card shows them once the picking's done (showing them earlier would take this away mid-pick)
  const done = () => {
    setAt(null);
    if (!picked.length) return;
    picked.forEach(onAdded);
    router.refresh();
  };

  return (
    <span onMouseEnter={(e) => show(e.currentTarget)} onMouseLeave={() => (picked.length ? keep() : leave())} data-no-open>
      <button
        type="button"
        onClick={(e) => (at ? done() : show(e.currentTarget.parentElement!))}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-dashed border-warn/40 px-2.5 py-1 text-[11.5px] text-warn transition-colors hover:border-warn hover:bg-warn-soft md:min-h-0"
      >
        No services on file
        {canEdit && <span aria-hidden className="text-[13px] leading-none">+</span>}
      </button>
      {at && (
        <Layer>
          <div
            role="dialog"
            aria-label="Add services"
            onMouseEnter={keep}
            onMouseLeave={() => (picked.length ? undefined : leave())}
            onClick={(e) => e.stopPropagation()}
            className="fixed z-[80] w-[min(320px,calc(100vw-24px))]"
            style={{ left: at.x, top: at.y, transform: at.up ? "translateY(-100%)" : undefined, padding: at.up ? "0 0 6px" : "6px 0 0", margin: at.up ? "0 0 -6px" : "-6px 0 0" }}
          >
            <div className="grid gap-3 rounded-[14px] border border-line bg-surface/95 p-3.5 text-left text-xs shadow-[0_24px_60px_-24px_rgba(0,0,0,0.85)] backdrop-blur" style={{ animation: "fadeIn .15s ease-out" }}>
              <span className="grid gap-0.5">
                <span className="font-heading text-[13px]">What do they buy from Kaizen?</span>
                <span className="text-muted">{canEdit ? "Pick each one; it saves as you go." : "An exec or lead can add their services."}</span>
              </span>
              {canEdit && (
                <span className="flex flex-wrap gap-1.5">
                  {SERVICES.map((s) => {
                    const on = picked.includes(s.slug);
                    return (
                      <button
                        key={s.slug}
                        type="button"
                        onClick={() => add(s.slug)}
                        aria-pressed={on}
                        className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors md:h-8 ${on ? "border-ok/50 bg-ok-soft text-ok" : "border-line text-muted hover:border-faint hover:text-fg"}`}
                      >
                        {on ? (
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
                            <path d="M5 12.5l4.5 4.5L19 7" />
                          </svg>
                        ) : (
                          <span aria-hidden>+</span>
                        )}
                        {s.label}
                      </button>
                    );
                  })}
                </span>
              )}
              {error && <span className="text-bad">{error}</span>}
              {picked.length > 0 && (
                <button type="button" onClick={done} disabled={busy} className="h-11 justify-self-end rounded-full bg-fg px-4 text-xs text-bg disabled:opacity-50 md:h-8">
                  {busy ? "Saving…" : "Done"}
                </button>
              )}
            </div>
          </div>
        </Layer>
      )}
    </span>
  );
}
