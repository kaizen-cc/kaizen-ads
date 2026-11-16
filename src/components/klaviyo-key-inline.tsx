"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { KLAVIYO_SCOPE_NAMES } from "@/lib/klaviyo/core";
import { connectKlaviyoKey } from "@/app/(team)/clients/[slug]/klaviyo-actions";

// Paste a client's Klaviyo key where the gap shows (the Email board and the Overview). It calls the same server action
// as the client page's Klaviyo card, so the check, the encryption, the first read and who may do it (a lead or an exec)
// are that card's, not a copy. `replace` is the failing-key case: the field sits behind a "Replace key" button.

export function KlaviyoKeyInline({ clientId, replace = false }: { clientId: string; replace?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(!replace);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      const r = await connectKlaviyoKey(clientId, key);
      if (!r.ok) return setError(r.error);
      setError(null);
      setKey("");
      setOpen(false);
      setNote(`Connected${r.account ? ` to ${r.account}` : ""}. The first 90 days are being read now; it takes a few minutes.`);
      router.refresh();
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
      <div className="flex flex-wrap gap-2">
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && !pending && save()}
          placeholder="pk_…"
          aria-label="Klaviyo private API key"
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
      <p className="text-[11.5px] text-faint">{`A read-only private key with Read access to ${KLAVIYO_SCOPE_NAMES}. It is checked, encrypted and never shown again.`}</p>
      {error && <p className="text-xs text-bad">{error}</p>}
    </div>
  );
}
