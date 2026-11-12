"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveGoogleCustomerId } from "@/app/(team)/settings/platform-actions";
import { connectKlaviyoKey } from "@/app/(team)/clients/[slug]/klaviyo-actions";
import { sentence, type GoogleClientHealth } from "@/lib/google-health";

// Inline fixes for a client's ad platforms, used in Settings › Sync health and the client's Team & setup: add the
// Google Ads customer ID (saved on their KPI board and pulled right away), or paste a Klaviyo private key (Full Access)
// (checked with Klaviyo, encrypted, then read right away; only its last 4 are ever shown again).

const input = "tabular h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-bg px-3 text-sm outline-none transition-colors focus:border-brand-text/60 md:h-9";
const primary = "inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg transition-opacity disabled:opacity-50 md:h-9";

/** "123-456-7890" and Save: saves the ID on the client's KPI board and starts its first sync */
export function GoogleIdField({ clientId, compact = false }: { clientId: string; compact?: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await saveGoogleCustomerId(clientId, value);
      if (!r.ok) return setError(r.error);
      setError(null);
      setSaved(r.id);
      setValue("");
      router.refresh();
    });
  if (saved) return <p className="text-[12.5px] text-ok">Saved {saved}. Its first sync is running; this updates in a minute or two.</p>;
  return (
    <div className={`grid gap-1.5 ${compact ? "" : "max-w-md"}`}>
      <div className="flex min-w-0 gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && value.trim() && !pending && save()}
          inputMode="numeric"
          autoComplete="off"
          placeholder="Google Ads ID, 123-456-7890"
          aria-label="Google Ads customer ID"
          className={input}
        />
        <button type="button" disabled={pending || !value.trim()} onClick={save} className={primary}>
          {pending ? "Saving…" : "Save and sync"}
        </button>
      </div>
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </div>
  );
}

/** "Paste API key", opening a field with the scopes it needs: the same check and save as the client's Team & setup */
export function KlaviyoKeyField({ clientId, label = "Paste API key", open: startOpen = false }: { clientId: string; label?: string; open?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await connectKlaviyoKey(clientId, key);
      if (!r.ok) return setError(r.error);
      setError(null);
      setKey("");
      setDone(`Connected${r.account ? ` to ${r.account}` : ""}. The first 90 days are being read now; it takes a few minutes.`);
      router.refresh();
    });
  if (done) return <p className="text-[12.5px] text-ok">{done}</p>;
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[12.5px] text-muted transition-colors hover:border-fg/30 hover:text-fg md:min-h-8 md:px-3">
        {label}
      </button>
    );
  return (
    <div className="grid max-w-md gap-1.5">
      <div className="flex min-w-0 gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          autoFocus={!startOpen}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && !pending && save()}
          placeholder="pk_…"
          aria-label="Klaviyo private API key"
          className={input}
        />
        <button type="button" disabled={pending || !key.trim()} onClick={save} className={primary}>
          {pending ? "Checking…" : "Connect"}
        </button>
      </div>
      <p className="text-[11.5px] leading-relaxed text-faint">
        A private key from their Klaviyo (Settings › API keys › Create Private API Key), with <b>Full Access</b>, so the same key covers the email team building and sending from Kaizen Ads later. Today Kaizen Ads only reads with it. Checked with Klaviyo, encrypted, never shown again.
      </p>
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </div>
  );
}

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const DOT = { synced: "bg-ok", pending: "bg-faint", behind: "bg-warn", failing: "bg-bad", missing: "bg-faint" } as const;

/** Team & setup: each of the client's Google Ads accounts, whether it syncs, and the fix in plain words when it doesn't */
export function GoogleSyncPanel({ clientId, health, canEdit }: { clientId: string; health: GoogleClientHealth; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);
  if (health.state === "missing")
    return (
      <div className="grid gap-3 rounded-[12px] border border-line bg-bg p-3.5">
        <p className="flex items-center gap-2 text-sm">
          <span className="h-2 w-2 shrink-0 rounded-full bg-faint" aria-hidden />
          Not connected: no Google Ads customer ID on file.
        </p>
        {canEdit ? <GoogleIdField clientId={clientId} /> : <p className="text-[12.5px] text-faint">A lead or an exec adds it here or on the KPI board.</p>}
      </div>
    );
  return (
    <div className="grid gap-2">
      <ul className="grid gap-2">
        {health.accounts.map((a) => (
          <li key={a.id} className="grid gap-1 rounded-[12px] border border-line bg-bg p-3.5">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[a.state]}`} aria-hidden />
              <span className="tabular font-medium">{a.id}</span>
              {!a.active && <span className="text-[12px] text-faint">KPI target paused</span>}
              <span suppressHydrationWarning className="text-[12px] text-faint">
                {a.state === "pending" ? "Waiting for its first sync" : a.lastSync ? `Synced ${ago(a.lastSync)}` : ""}
              </span>
            </span>
            {a.error ? (
              <span className="grid gap-0.5 pl-4 text-[12.5px] leading-relaxed">
                <span className="text-bad">{sentence(a.error.message)}</span>
                <span className="text-muted">{a.error.fix}</span>
              </span>
            ) : a.state === "behind" ? (
              <span className="pl-4 text-[12.5px] text-warn">No successful sync in over a day. It retries every 30 minutes.</span>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit &&
        (adding ? (
          <GoogleIdField clientId={clientId} />
        ) : (
          <button type="button" onClick={() => setAdding(true)} className="w-fit min-h-11 text-[13px] text-muted hover:text-fg md:min-h-0">
            Add another Google Ads account
          </button>
        ))}
    </div>
  );
}
