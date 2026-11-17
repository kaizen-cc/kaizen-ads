"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { EMAIL_PROVIDERS, KEY_HELP, PROVIDER_NAME, type EmailProvider } from "@/lib/email-providers/core";
import { connectEmailKey } from "@/app/(team)/clients/[slug]/klaviyo-actions";

// Paste a client's email provider key where the gap shows (the Email board, the Overview and Sync health). It calls the
// same server action as the client page's card, so the check, the encryption, the first read and who may do it (a lead
// or an exec) are that card's, not a copy. When nothing is connected the person picks the provider (Klaviyo, Brevo or
// Customer.io); a failing connection keeps its own, behind a "Replace key" button. Customer.io also takes its region
// and the purchase event whose value counts as revenue.

/** The three providers as touch-sized choices, one selected */
export function ProviderChoice({ value, onChange }: { value: EmailProvider; onChange: (p: EmailProvider) => void }) {
  return (
    <div role="radiogroup" aria-label="Email provider" className="flex flex-wrap gap-1.5">
      {EMAIL_PROVIDERS.map((p) => (
        <button
          key={p}
          type="button"
          role="radio"
          aria-checked={value === p}
          onClick={() => onChange(p)}
          className={`inline-flex min-h-11 items-center rounded-full border px-4 text-[13px] transition-colors md:min-h-9 ${value === p ? "border-fg bg-fg text-bg" : "border-line bg-surface text-muted hover:text-fg"}`}
        >
          {PROVIDER_NAME[p]}
        </button>
      ))}
    </div>
  );
}

/** Customer.io's extras: the region (blank finds it) and the purchase event */
export function CustomerioExtras({ region, onRegion, event, onEvent }: { region: string; onRegion: (r: string) => void; event: string; onEvent: (e: string) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[8rem_1fr]">
      <select value={region} onChange={(e) => onRegion(e.target.value)} aria-label="Customer.io region" className="h-11 rounded-[10px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/60 md:h-10">
        <option value="">Region: find it</option>
        <option value="us">US</option>
        <option value="eu">EU</option>
      </select>
      <input value={event} onChange={(e) => onEvent(e.target.value)} autoComplete="off" spellCheck={false} placeholder="Purchase event name (optional), e.g. order_completed" aria-label="Purchase event whose value counts as revenue" className="h-11 min-w-0 rounded-[10px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/60 md:h-10" />
    </div>
  );
}

export function KlaviyoKeyInline({ clientId, replace = false, provider = null }: { clientId: string; replace?: boolean; provider?: EmailProvider | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(!replace);
  const [picked, setPicked] = useState<EmailProvider>("klaviyo");
  const [key, setKey] = useState("");
  const [region, setRegion] = useState("");
  const [event, setEvent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const chosen: EmailProvider = provider ?? picked;
  const h = KEY_HELP[chosen];

  const save = () =>
    start(async () => {
      // Quick: the board isn't worked out again before the answer (the card is marked here instead), so the next
      // client can be connected straight away
      const onBoard = window.location.pathname.startsWith("/kpis");
      const r = await connectEmailKey(clientId, chosen, key, { quick: onBoard, region, revenueEvent: event });
      if (!r.ok) return setError(r.error);
      setError(null);
      setKey("");
      setOpen(false);
      setNote(`Connected${r.account ? ` to ${r.account}` : ""}. The first 90 days are being read now; it takes a few minutes.`);
      window.dispatchEvent(new CustomEvent("klaviyo-connected", { detail: clientId }));
      if (!onBoard) router.refresh();
    });

  if (!open)
    return (
      <div className="grid gap-1.5">
        <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 w-fit items-center rounded-full bg-fg px-4 text-xs font-medium text-bg md:min-h-9">
          Replace key
        </button>
        {note && <p className="text-xs text-muted">{note}</p>}
      </div>
    );
  return (
    <div className="grid gap-2">
      {!provider && <ProviderChoice value={picked} onChange={setPicked} />}
      <div className="flex flex-wrap gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && !pending && save()}
          placeholder={h.placeholder}
          aria-label={h.label}
          className="tabular h-11 min-w-0 flex-1 basis-40 rounded-[10px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/60"
        />
        <button type="button" disabled={pending || !key.trim()} onClick={save} className="h-11 rounded-full bg-brand px-5 text-sm font-medium text-white disabled:opacity-50 md:h-10">
          {pending ? "Checking…" : replace ? "Replace" : "Connect"}
        </button>
        {replace && (
          <button type="button" onClick={() => setOpen(false)} className="h-11 rounded-full px-3 text-sm text-muted hover:text-fg md:h-10">
            Cancel
          </button>
        )}
      </div>
      {chosen === "customerio" && <CustomerioExtras region={region} onRegion={setRegion} event={event} onEvent={setEvent} />}
      <p className="text-[11.5px] text-faint">{`${h.help} It is checked, encrypted and never shown again.`}</p>
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
