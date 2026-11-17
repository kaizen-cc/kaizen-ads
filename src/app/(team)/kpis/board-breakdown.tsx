"use client";

import { useEffect, useState } from "react";
import { EmailBreakdown } from "@/components/email-breakdown";
import type { BCampaign, BFlow } from "@/lib/email-breakdown";
import type { EmailProvider } from "@/lib/email-providers/core";
import { loadEmailBreakdown } from "./email-breakdown-actions";

// The breakdown inside an opened account on the Email board: fetched when the sheet opens so the board stays light.

export function BoardBreakdown({ clientId, currency, provider = null, revenueMeasured = true }: { clientId: string; currency: string | null; provider?: EmailProvider | null; revenueMeasured?: boolean }) {
  const [state, setState] = useState<{ id: string; data: { campaigns: BCampaign[]; flows: BFlow[] } | null; error: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    loadEmailBreakdown(clientId)
      .then((r) => live && setState({ id: clientId, data: r.ok ? r : null, error: r.ok ? null : r.error }))
      .catch(() => live && setState({ id: clientId, data: null, error: "Couldn't read this account's campaigns and flows." }));
    return () => {
      live = false;
    };
  }, [clientId]);
  if (!state || state.id !== clientId)
    return (
      <div className="grid gap-3" aria-busy="true" aria-label="Loading campaigns and flows">
        <div className="h-6 w-40 animate-pulse rounded-full bg-surface-2" />
        <div className="h-48 animate-pulse rounded-[16px] bg-surface-2" />
      </div>
    );
  if (!state.data) return <p className="text-sm text-bad">{state.error}</p>;
  return <EmailBreakdown campaigns={state.data.campaigns} flows={state.data.flows} currency={currency} clientId={clientId} provider={provider} revenueMeasured={revenueMeasured} />;
}
