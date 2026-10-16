"use client";

import { useState, useTransition } from "react";
import { fixWithClaude, muteError, resolveError } from "./error-actions";

/** Mark fixed, stop alerting, or have Claude fix it (a pull request to approve; nothing goes live until it's merged). */
export function ErrorButtons({ fingerprint, fixing }: { fingerprint: string; fixing: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState("");
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="flex flex-wrap justify-end gap-1.5">
        <button
          disabled={pending}
          onClick={() => start(() => resolveError(fingerprint))}
          title="If it happens again you'll be emailed again."
          className="rounded-full border border-line px-2.5 py-1 text-xs text-muted hover:text-fg disabled:opacity-40"
        >
          Mark fixed
        </button>
        <button disabled={pending} onClick={() => start(() => muteError(fingerprint))} title="Still recorded, never emailed." className="rounded-full px-2.5 py-1 text-xs text-faint hover:text-fg disabled:opacity-40">
          Stop alerting
        </button>
        {!fixing && (
          <button
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError("");
                const r = await fixWithClaude(fingerprint);
                if (r.error) setError(r.error);
                else if (r.url) window.open(r.url, "_blank", "noreferrer");
              })
            }
            title="Claude finds the cause and opens a pull request. Nothing goes live until you merge it."
            className="rounded-full bg-brand px-2.5 py-1 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-40"
          >
            {pending ? "…" : "Have Claude fix it"}
          </button>
        )}
      </span>
      {error && <span className="max-w-64 text-right text-[11px] text-bad">{error}</span>}
    </span>
  );
}
