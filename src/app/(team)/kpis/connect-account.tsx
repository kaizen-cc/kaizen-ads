"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { field } from "@/components/ui";
import { connectState } from "@/lib/kpi/connect";
import { platformLabel, type KpiPlatform } from "@/lib/kpi/platform";
import { linkTikTokAccount } from "../settings/tiktok-actions";
import { connectGoogleAccount, connectMetaAccount, pullClientKpis } from "./actions";

export type ConnectRow = { id: string; clientId: string; slug: string; client: string; platform: KpiPlatform; accountId: string | null; status: string; error: string | null; canConnect: boolean };
export type FreeAccounts = { meta: { id: string; name: string; bm?: { id: string; name: string } }[]; tiktok: { id: string; name: string }[] };

/** Does this card need an ad account connected, or can't it read the one it has */
export const needsConnect = (r: Pick<ConnectRow, "platform" | "accountId" | "status" | "error">) => connectState(r.platform, r.accountId, r.status, r.error).kind !== "ok";

const primary = "inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-fg px-5 text-[13px] font-medium text-bg disabled:opacity-50 md:h-10";
const ghost = "inline-flex h-11 shrink-0 items-center justify-center rounded-full border border-line px-4 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:h-10";

/**
 * Connect a card's ad account right on the card: the same writes the client page and Sync health read (Meta's account on
 * the client, Google's customer ID on the KPI row, TikTok's advertiser link), then the first pull, then the board
 * refreshes. A card the platform won't let us read says why in plain words and what to do, with Check again.
 */
export function ConnectAccount({ r, free }: { r: ConnectRow; free: FreeAccounts }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const state = connectState(r.platform, r.accountId, r.status, r.error);
  if (state.kind === "ok") return null;
  const name = platformLabel(r.platform);

  const run = (job: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) => {
    setErr(null);
    setNote(null);
    start(async () => {
      const res = await job().catch(() => ({ ok: false as const, error: "Couldn't save. Try again." }));
      if (!res.ok) setErr(res.error);
      else {
        if (done) setNote(done);
        setChanging(false);
        router.refresh();
      }
    });
  };
  const checkAgain = () => run(() => pullClientKpis(r.clientId), "Checked. The card updates if it can read the account now.");

  // Without permission: the call to action, and where to do it
  const clientPage = (
    <Link href={`/clients/${r.slug}`} className={ghost}>
      Connect on the client page
    </Link>
  );

  let body: React.ReactNode;
  if (state.kind === "blocked") {
    body = (
      <div className="grid gap-2">
        <p className="text-[13px] leading-snug text-bad">{state.why}</p>
        <p className="text-xs leading-relaxed text-muted">{state.fix}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={busy} onClick={checkAgain} className={primary}>
            {busy ? "Checking…" : "Check again"}
          </button>
          {r.platform === "google" && r.canConnect && (
            <button type="button" onClick={() => setChanging((c) => !c)} className={ghost}>
              Wrong ID?
            </button>
          )}
          {!r.canConnect && clientPage}
        </div>
        {changing && r.canConnect && <GoogleForm r={r} busy={busy} run={run} initial={r.accountId ?? ""} label="Save" />}
      </div>
    );
  } else if (!r.canConnect) {
    body = (
      <div className="grid gap-2">
        <p className="text-[13px] text-muted">{name} isn&apos;t connected for {r.client}.</p>
        <div className="flex">{clientPage}</div>
      </div>
    );
  } else if (r.platform === "meta") {
    body = <MetaForm r={r} list={free.meta} busy={busy} run={run} />;
  } else if (r.platform === "google") {
    body = <GoogleForm r={r} busy={busy} run={run} initial="" label="Connect" />;
  } else {
    body = <TikTokForm r={r} list={free.tiktok} busy={busy} run={run} />;
  }

  return (
    <div className="grid gap-2 rounded-[14px] border border-dashed border-faint/50 bg-surface-2/60 p-3">
      <p className="text-xs font-medium text-fg">{state.kind === "missing" ? `Connect ${name}` : `${name} can't read this account`}</p>
      {body}
      {err && (
        <p className="break-words text-xs text-bad" role="alert">
          {err}
        </p>
      )}
      {note && !err && <p className="text-xs text-muted">{note}</p>}
    </div>
  );
}

type Run = (job: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) => void;

function MetaForm({ r, list, busy, run }: { r: ConnectRow; list: FreeAccounts["meta"]; busy: boolean; run: Run }) {
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  return (
    <form
      className="grid gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData();
        f.set("picked", picked);
        f.set("typed", typed);
        run(() => connectMetaAccount(r.clientId, f));
      }}
    >
      {list.length > 0 ? (
        <select aria-label="Pick their ad account" value={picked} onChange={(e) => setPicked(e.target.value)} className={field}>
          <option value="">Pick their ad account</option>
          {list.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · act_{a.id}
            </option>
          ))}
        </select>
      ) : (
        <p className="text-xs text-faint">No shared ad accounts are waiting. Type the ID, or have the client share the account with Kaizen&apos;s Business Manager first.</p>
      )}
      <input aria-label="Or type the ad account ID" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Or type it: act_123456789" className={`${field} tabular`} inputMode="text" autoComplete="off" />
      <div>
        <button type="submit" disabled={busy || (!picked && !typed.trim())} className={primary}>
          {busy ? "Linking…" : "Link"}
        </button>
      </div>
    </form>
  );
}

function GoogleForm({ r, busy, run, initial, label }: { r: ConnectRow; busy: boolean; run: Run; initial: string; label: string }) {
  const [id, setId] = useState(initial);
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData();
        f.set("customer_id", id);
        run(() => connectGoogleAccount(r.id, f));
      }}
    >
      <input aria-label="Google Ads customer ID" value={id} onChange={(e) => setId(e.target.value)} placeholder="123-456-7890" className={`${field} tabular min-w-0 flex-1`} inputMode="numeric" autoComplete="off" />
      <button type="submit" disabled={busy || !id.trim()} className={primary}>
        {busy ? "Connecting…" : label}
      </button>
    </form>
  );
}

function TikTokForm({ r, list, busy, run }: { r: ConnectRow; list: FreeAccounts["tiktok"]; busy: boolean; run: Run }) {
  const [picked, setPicked] = useState("");
  if (!list.length)
    return <p className="text-xs leading-relaxed text-faint">No TikTok ad accounts are waiting to be linked. Connect TikTok in Settings, Sync health, or ask the client to add Kaizen to their TikTok ad account.</p>;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        // The same link Settings > Sync health > TikTok uses, which also starts the first pull
        run(() => linkTikTokAccount(picked, r.clientId));
      }}
    >
      <select aria-label="Pick their TikTok ad account" value={picked} onChange={(e) => setPicked(e.target.value)} className={`${field} min-w-0 flex-1`}>
        <option value="">Pick their TikTok ad account</option>
        {list.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <button type="submit" disabled={busy || !picked} className={primary}>
        {busy ? "Linking…" : "Link"}
      </button>
    </form>
  );
}
