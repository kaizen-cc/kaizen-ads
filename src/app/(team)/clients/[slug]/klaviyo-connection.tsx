"use client";

import { useRouter } from "next/navigation";
import { KlaviyoLocations } from "@/components/klaviyo-locations";
import { LinePauseControl } from "@/components/line-pause";
import { EmailHistory } from "./email-history";
import { KlaviyoMetricPicker } from "@/components/klaviyo-metric-picker";
import { CustomerioExtras, ProviderChoice } from "@/components/klaviyo-key-inline";
import { useState, useTransition } from "react";
import type { KlaviyoConnectionView } from "@/lib/klaviyo/store";
import { KLAVIYO_SCOPE_NAMES } from "@/lib/klaviyo/core";
import { KEY_HELP, plainEmailError, providerName, type EmailProvider } from "@/lib/email-providers/core";
import { sentence } from "@/lib/google-health";
import { connectEmailKey, removeKlaviyoKey, setCustomerioRevenueEvent, syncKlaviyoNow } from "./klaviyo-actions";

// The client's email provider in Team & setup (Klaviyo, Brevo or Customer.io): the account it reads (name and time zone,
// from the provider itself), the key's last 4, when it was last read, and Replace, Remove and Sync now. A lead or exec
// pastes a read-only key; it's never shown again. A client has one provider: with none connected the lead or exec picks.
// The conversion metric picker and the location breakdown are Klaviyo's only. Read only: Kaizen OS never sends, edits
// or schedules anything in the provider.

const STEPS: Record<EmailProvider, string[]> = {
  klaviyo: ["In the client's Klaviyo account: Settings › Account › API keys › Create Private API Key.", `Name it "Kaizen OS", choose Custom key, and give Read Access to ${KLAVIYO_SCOPE_NAMES}. Nothing else.`, "Create it, copy the key (it starts with pk_) and paste it here."],
  brevo: ["In the client's Brevo account: SMTP & API › API keys › Generate a new API key.", 'Name it "Kaizen OS", generate it and copy the key (it starts with xkeysib-).', "Paste it here. Revenue shows when their store is connected to Brevo (ecommerce attribution)."],
  customerio: ["In the client's Customer.io workspace: Settings › Account settings › API credentials › App API keys.", 'Create a key named "Kaizen OS" and copy it.', "Paste it here, with the region if you know it, and the name of their purchase event if they have one (Customer.io reports no revenue of its own)."],
};

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function KlaviyoConnection({ clientId, conn, canEdit }: { clientId: string; conn: KlaviyoConnectionView | null; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<EmailProvider>("klaviyo");
  const [key, setKey] = useState("");
  const [region, setRegion] = useState("");
  const [event, setEvent] = useState("");
  const [eventNow, setEventNow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const provider: EmailProvider = conn?.provider ?? picked;
  const name = providerName(provider);
  // Why it isn't reading, in plain words with the fix (a missing revenue source only warns)
  const plain = conn ? plainEmailError(provider, conn.error, conn.status) : null;
  const failing = plain?.severity === "bad";
  const open = editing || (!conn && canEdit);
  const h = KEY_HELP[provider];

  const save = () =>
    start(async () => {
      const r = await connectEmailKey(clientId, provider, key, { region, revenueEvent: event });
      if (!r.ok) return setError(r.error);
      setError(null);
      setKey("");
      setEditing(false);
      setNote(`Connected${r.account ? ` to ${r.account}` : ""}. The first 90 days are being read now; it takes a few minutes.`);
      router.refresh();
    });

  return (
    <div id="klaviyo" className="grid scroll-mt-24 gap-3">
      {conn && (
        <div className="grid gap-2 rounded-[12px] border border-line bg-bg p-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <span className={`h-2 w-2 shrink-0 rounded-full ${failing ? "bg-bad" : conn.lastSyncedAt ? "bg-ok" : "bg-warn"}`} aria-hidden />
            <span className="min-w-0 truncate font-medium">{conn.account ?? `${name} account`}</span>
            <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-muted">{name}</span>
            <span className="tabular text-[12px] text-faint">key ••••{conn.last4 ?? "????"}</span>
            {conn.timezone && <span className="text-[12px] text-faint">{conn.timezone}</span>}
            {conn.region && <span className="text-[12px] text-faint">{conn.region.toUpperCase()} region</span>}
          </div>
          {plain ? (
            <p className="grid gap-0.5 text-[12px] leading-relaxed">
              <span className={plain.severity === "bad" ? "text-bad" : "text-warn"}>{sentence(plain.message)}</span>
              <span className="text-muted">{plain.fix}</span>
            </p>
          ) : (
            <p className="text-[12px] text-muted">
              {conn.lastSyncedAt
                ? `Read ${ago(conn.lastSyncedAt)}${conn.backfilled ? "" : " · the first 90 days are still being read"}`
                : "Connected. The first read (90 days back) runs in the next few minutes."}
            </p>
          )}
          {provider === "brevo" && <p className="text-[12px] text-muted">Brevo gives campaigns, lists and, with their store connected, revenue. Its API lists no automations, so those are not measured.</p>}
          {provider === "customerio" && (
            <div className="grid gap-1.5">
              <p className="text-[12px] text-muted">
                {conn.revenueEvent ? (conn.revenueRead ? `Revenue is the value of their "${conn.revenueEvent}" event (last 30 days are read each run).` : `Revenue event "${conn.revenueEvent}" set; no value read from it yet.`) : "No revenue: Customer.io reports none. Name their purchase event to count its value."}
              </p>
              {canEdit && (
                <div className="flex flex-wrap gap-2">
                  <input value={eventNow ?? conn.revenueEvent ?? ""} onChange={(e) => setEventNow(e.target.value)} spellCheck={false} autoComplete="off" placeholder="Purchase event name" aria-label="Purchase event whose value counts as revenue" className="h-11 min-w-0 flex-1 basis-48 rounded-[10px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/60 md:h-9" />
                  <button
                    type="button"
                    disabled={pending || eventNow == null || eventNow === (conn.revenueEvent ?? "")}
                    onClick={() =>
                      start(async () => {
                        const r = await setCustomerioRevenueEvent(clientId, eventNow ?? "");
                        setError(r.ok ? null : r.error);
                        if (r.ok) setNote("Saved. The numbers are being read again with it.");
                        setEventNow(null);
                        router.refresh();
                      })
                    }
                    className="h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:h-9"
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          )}
          {provider === "klaviyo" && <KlaviyoMetricPicker clientId={clientId} current={conn.conversionMetrics ?? []} fallback={conn.conversionMetric ?? null} canPick={canEdit} />}
          {provider === "klaviyo" && <KlaviyoLocations clientId={clientId} />}
          <EmailHistory clientId={clientId} />
          <LinePauseControl clientId={clientId} service="email-marketing" label="Pause email for this client" />
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setNote(`Reading ${name}… this takes about a minute.`);
                  const r = await syncKlaviyoNow(clientId);
                  setNote(null);
                  setError(r.ok ? null : r.error);
                  router.refresh();
                })
              }
              className="min-h-11 text-[13px] text-brand-text hover:underline disabled:opacity-50 md:min-h-0"
            >
              Sync now
            </button>
            {canEdit && (
              <>
                <button type="button" disabled={pending} onClick={() => setEditing((v) => !v)} className="min-h-11 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:min-h-0">
                  Replace key
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    if (!confirm(`Remove ${name} from this client? The key is deleted and syncing stops; the email history already read stays. You can then connect another provider.`)) return;
                    start(async () => {
                      const r = await removeKlaviyoKey(clientId);
                      setError(r.ok ? null : r.error);
                      router.refresh();
                    });
                  }}
                  className="min-h-11 text-[13px] text-faint hover:text-bad disabled:opacity-50 md:min-h-0"
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {!conn && !canEdit && <p className="text-sm text-faint">Not connected. A lead or an exec connects the client&apos;s email provider (Klaviyo, Brevo or Customer.io) with a read-only key.</p>}

      {open && canEdit && (
        <div className="grid gap-3 rounded-[12px] border border-line bg-bg p-4">
          {!conn && <ProviderChoice value={picked} onChange={setPicked} />}
          <ol className="grid list-decimal gap-1 pl-5 text-[13px] leading-relaxed text-muted">
            {STEPS[provider].map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && !pending && save()}
            placeholder={h.placeholder}
            aria-label={h.label}
            className="tabular h-11 rounded-[10px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/60"
          />
          {provider === "customerio" && <CustomerioExtras region={region} onRegion={setRegion} event={event} onEvent={setEvent} />}
          <p className="text-[11.5px] text-faint">{`Checked with ${name}, encrypted, and never shown again. Only the team enters keys; never ask a client to paste one in a chat.`}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={pending || !key.trim()} onClick={save} className="h-11 rounded-full bg-brand px-5 text-sm font-medium text-white disabled:opacity-50 md:h-9">
              {pending ? "Checking…" : conn ? "Check and replace" : "Check and connect"}
            </button>
            {conn && (
              <button type="button" onClick={() => setEditing(false)} className="h-11 rounded-full px-4 text-sm text-muted hover:text-fg md:h-9">
                Cancel
              </button>
            )}
          </div>
        </div>
      )}
      {note && <p className="text-[12.5px] text-muted">{note}</p>}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </div>
  );
}
