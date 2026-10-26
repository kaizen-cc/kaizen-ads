"use client";

import { useEffect } from "react";
import { reportClientError } from "@/app/error-actions";

// Shown in place of a page that crashed; the sidebar stays usable.
export default function AppError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    // Errors with a digest came from the server and were already reported there
    if (!error.digest) reportClientError({ message: error.message, path: window.location.pathname, stack: error.stack });
  }, [error]);

  return (
    <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-3 rounded-brand border border-line bg-surface p-6 text-center md:mt-16 md:p-8">
      <p className="font-heading text-lg">Something went wrong on this page</p>
      <p className="text-sm text-muted">We&apos;ve been notified automatically. Your work is safe.</p>
      <button onClick={() => retry()} className="mt-2 h-12 w-full rounded-brand bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover md:h-9 md:w-auto">
        Try again
      </button>
    </div>
  );
}
