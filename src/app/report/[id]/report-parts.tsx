"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { prepareClientReport } from "@/app/(team)/kpis/sprint-actions";

export function PrintBar({ auditId, ready }: { auditId: string; ready: boolean }) {
  return (
    <div className="no-print mx-auto mb-6 flex max-w-[8.5in] flex-wrap items-center justify-between gap-3 text-sm">
      <Link href={`/kpis/audit/${auditId}`} className="text-[#4d464f] hover:text-[#17131a]">
        ← Back to the internal audit
      </Link>
      {ready && (
        <span className="flex items-center gap-3">
          <span className="text-xs text-[#8a8189]">Choose &ldquo;Save as PDF&rdquo; in the print window</span>
          <button type="button" onClick={() => window.print()} className="h-10 rounded-full bg-[#c8102e] px-5 font-medium text-white hover:brightness-110">
            Download PDF
          </button>
        </span>
      )}
    </div>
  );
}

/** Writes the client version the first time it's opened. */
export function WriteReport({ auditId }: { auditId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    start(async () => {
      const r = await prepareClientReport(auditId);
      if (r.ok) router.refresh();
      else setError(r.error);
    });
  }, [auditId, router]);
  return (
    <div className="grid place-items-center gap-3 py-16 text-center">
      {pending && <span className="h-6 w-6 animate-spin rounded-full border-2 border-[#c8102e] border-t-transparent" />}
      <p className="text-sm text-[#4d464f]">{error ?? "Writing the client version of this audit, in our voice. About a minute…"}</p>
    </div>
  );
}
