"use client";

import { useEffect } from "react";
import { reportClientError } from "@/app/error-actions";

// Last resort when the whole app shell fails to render.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    if (!error.digest) reportClientError({ message: error.message, path: window.location.pathname, stack: error.stack });
  }, [error]);

  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        {/* Phones: room for the notch and home indicator, and a full-width button under the thumb */}
        <style>{`@media (max-width: 767px) { .ge-body { min-height: 100dvh !important; padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom) !important; box-sizing: border-box; } .ge-retry { width: 100%; min-height: 48px; font-size: 15px; } }`}</style>
      </head>
      <body className="ge-body" style={{ background: "#0b0b0b", color: "#f2f2f2", fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", maxWidth: 380, padding: 24 }}>
          <p style={{ fontSize: 18, fontWeight: 600 }}>Kaizen Ads hit a problem</p>
          <p style={{ color: "#999", fontSize: 14 }}>We&apos;ve been notified automatically. Your work is safe.</p>
          <button className="ge-retry" onClick={() => retry()} style={{ marginTop: 12, background: "#B21E2C", color: "#fff", border: 0, borderRadius: 6, padding: "10px 16px", cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
