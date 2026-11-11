"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { KlaviyoConnectionView } from "@/lib/klaviyo/store";
import { KLAVIYO_SCOPE_NAMES, plainKlaviyoError } from "@/lib/klaviyo/core";
import { sentence } from "@/lib/google-health";
import { connectKlaviyoKey, removeKlaviyoKey, syncKlaviyoNow } from "./klaviyo-actions";

// Klaviyo in Team & setup: the account it reads (name and time zone, from Klaviyo itself), the key's last 4, when it
// was last read, and Replace, Remove and Sync now. A lead or exec pastes a read-only private API key; it's never shown
// again. Read only: Kaizen Ads never sends, edits or schedules anything in Klaviyo.

const SCOPES = KLAVIYO_SCOPE_NAMES;

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function KlaviyoConnection({ clientId, conn, canEdit }: { clientId: string; conn: KlaviyoConnectionView | null; canEdit: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // Why it isn't reading, in plain words with the fix (a missing Placed Order metric only warns)
  const plain = conn ? plainKlaviyoError(conn.error, conn.status) : null;
  const failing = plain?.severity === "bad";
  const open = editing || (!conn && canEdit);

  const save = () =>
    start(async () => {
      const r = await connectKlaviyoKey(clientId, key);
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
            <span className="min-w-0 truncate font-medium">{conn.account ?? "Klaviyo account"}</span>
            <span className="tabular text-[12px] text-faint">key ••••{conn.last4 ?? "????"}</span>
            {conn.timezone && <span className="text-[12px] text-faint">{conn.timezone}</span>}
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
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-0.5">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setNote("Reading Klaviyo… this takes about a minute.");
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
                    if (!confirm("Remove Klaviyo from this client? The key is deleted and syncing stops; the email history already read stays.")) return;
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

      {!conn && !canEdit && <p className="text-sm text-faint">Not connected. A lead or an exec connects Klaviyo with a read-only key.</p>}

      {open && canEdit && (
        <div className="grid gap-3 rounded-[12px] border border-line bg-bg p-4">
          <ol className="grid list-decimal gap-1 pl-5 text-[13px] leading-relaxed text-muted">
            <li>In the client&apos;s Klaviyo account: Settings › Account › API keys › Create Private API Key.</li>
            <li>Name it &quot;Kaizen Ads&quot;, choose Custom key, and give Read Access to {SCOPES}. Nothing else.</li>
            <li>Create it, copy the key (it starts with pk_) and paste it here.</li>
          </ol>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && key.trim() && !pending && save()}
            placeholder="pk_…"
            aria-label="Klaviyo private API key"
            className="tabular h-11 rounded-[10px] border border-line bg-surface px-3 text-sm outline-none focus:border-brand-text/60"
          />
          <p className="text-[11.5px] text-faint">Checked with Klaviyo, encrypted, and never shown again. Only the team enters keys; never ask a client to paste one in a chat.</p>
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
