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
      <body style={{ background: "#0b0b0b", color: "#f2f2f2", fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0 }}>
        <div style={{ textAlign: "center", maxWidth: 380, padding: 24 }}>
          <p style={{ fontSize: 18, fontWeight: 600 }}>Kaizen Ads hit a problem</p>
          <p style={{ color: "#999", fontSize: 14 }}>We&apos;ve been notified automatically. Your work is safe.</p>
          <button onClick={() => retry()} style={{ marginTop: 12, background: "#B21E2C", color: "#fff", border: 0, borderRadius: 6, padding: "10px 16px", cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
