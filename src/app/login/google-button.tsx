"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";

export function GoogleButton({ next }: { next?: string }) {
  const [loading, setLoading] = useState(false);

  async function signIn() {
    setLoading(true);
    await createClient().auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback${next ? `?next=${encodeURIComponent(next)}` : ""}`,
        queryParams: { hd: "kaizenmarketing.agency", prompt: "select_account" },
      },
    });
  }

  return (
    <button
      onClick={signIn}
      disabled={loading}
      className="flex h-12 w-full items-center justify-center gap-3 rounded-brand border border-line bg-surface-2 text-sm font-medium text-fg transition-colors hover:border-faint active:border-faint disabled:opacity-60 md:h-11"
    >
      <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
        <path fill="currentColor" d="M44.5 20H24v8.5h11.8C34.7 33.9 30.1 37 24 37c-7.2 0-13-5.8-13-13s5.8-13 13-13c3.1 0 5.9 1.1 8.1 2.9l6.4-6.4C34.6 4.1 29.6 2 24 2 11.8 2 2 11.8 2 24s9.8 22 22 22c11 0 21-8 21-22 0-1.3-.2-2.7-.5-4z" />
      </svg>
      {loading ? "Redirecting…" : "Continue with Google"}
    </button>
  );
}
