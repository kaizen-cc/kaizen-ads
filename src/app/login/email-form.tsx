"use client";

import { useState, useTransition } from "react";
import { requestMagicLink } from "./actions";

export function EmailForm({ next }: { next?: string }) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const res = await requestMagicLink(email, next);
      if (res.ok) setSentTo(email.trim().toLowerCase());
      else setError(res.error);
    });
  }

  if (sentTo) {
    return (
      <div className="rounded-brand border border-line bg-surface-2 p-4 text-sm">
        <p className="font-medium">Check your inbox</p>
        <p className="mt-1 text-muted">
          If <span className="text-fg [overflow-wrap:anywhere]">{sentTo}</span> is on file with Kaizen, a sign-in link is on its way. It works
          once and expires in 1 hour.
        </p>
        <button onClick={() => setSentTo(null)} className="mt-2 min-h-11 text-sm text-brand-text hover:underline md:mt-3 md:min-h-0">
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <label htmlFor="email" className="text-sm text-muted">
        Your work email
      </label>
      <input
        id="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@yourbrand.com"
        className="h-12 rounded-brand border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text md:h-11"
      />
      {error && <p className="text-sm text-brand-text">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="h-12 rounded-brand bg-brand text-sm font-medium text-white transition-colors hover:bg-brand-hover active:brightness-110 disabled:opacity-60 md:h-11"
      >
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
    </form>
  );
}
