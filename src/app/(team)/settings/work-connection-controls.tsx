"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmMyAsana, saveMyAsanaWorkspaces } from "./work-connection-actions";

// The controls on one of your own work accounts (Settings › Connections › Yours): which account it is shows on the
// row; here you switch to another account, disconnect it, or (Asana signed in as someone else) confirm it on purpose.
// Switching signs out of this one first; if the browser is signed in to someone else's Slack or Asana, sign out there
// before you pick the account.

const pill = "inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[13px] text-fg transition hover:bg-surface-2 disabled:opacity-50 md:min-h-9";
const primary = "inline-flex min-h-11 items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg transition hover:opacity-90 disabled:opacity-50 md:min-h-9";

export function AccountControls({ service, back, pending, reconnect }: { service: "slack" | "asana"; back: string; pending: string | null; reconnect: string | null }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const name = service === "slack" ? "Slack" : "Asana";
  // Slack's disconnect answers in JSON; Asana's redirects (switch=1 goes straight on to its sign-in)
  const go = (then: "switch" | "off") =>
    start(async () => {
      setError(null);
      if (service === "asana") {
        const f = document.createElement("form");
        f.method = "POST";
        f.action = `/api/asana/disconnect?next=${encodeURIComponent(back)}${then === "switch" ? "&switch=1" : ""}`;
        document.body.appendChild(f);
        f.submit();
        return;
      }
      const res = await fetch("/api/slack/disconnect", { method: "POST" }).catch(() => null);
      if (!res?.ok) return setError(`Couldn't disconnect ${name}. Try again.`);
      // An API route that redirects to Slack's sign-in: a full page load, not a client navigation
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (then === "switch") window.location.assign(`/api/slack/connect?read=1&next=${encodeURIComponent(back)}`);
      else router.refresh();
    });
  const confirm = () =>
    start(async () => {
      const r = await confirmMyAsana();
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  return (
    <div className="grid w-full gap-2">
      {pending && (
        <p role="alert" className="rounded-[12px] border border-warn/40 bg-warn-soft px-3 py-2 text-[13px] leading-relaxed text-fg [overflow-wrap:anywhere]">
          You&apos;re signed into {name} as <strong>{pending}</strong>, not you. Use this account anyway? If it&apos;s someone else&apos;s, sign out of {name} in this browser first, then Switch account.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {pending && (
          <button type="button" disabled={busy} onClick={confirm} className={primary}>
            Use this account anyway
          </button>
        )}
        {reconnect && (
          <a href={reconnect} className={primary}>
            Reconnect
          </a>
        )}
        <button type="button" disabled={busy} onClick={() => go("switch")} className={pill}>
          Switch account
        </button>
        <button type="button" disabled={busy} onClick={() => go("off")} className={`${pill} text-muted`}>
          Disconnect
        </button>
      </div>
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </div>
  );
}

/** Which Asana workspaces count for you: Kaizen's always (locked), others only when you tick them (saved on change) */
export function AsanaWorkspaces({ spaces }: { spaces: { gid: string; name: string; on: boolean; locked: boolean }[] }) {
  const router = useRouter();
  const [on, setOn] = useState(() => new Set(spaces.filter((s) => s.on && !s.locked).map((s) => s.gid)));
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toggle = (gid: string) => {
    const next = new Set(on);
    if (next.has(gid)) next.delete(gid);
    else next.add(gid);
    setOn(next);
    start(async () => {
      const r = await saveMyAsanaWorkspaces([...next]);
      if (!r.ok) setError(r.error);
      else router.refresh();
    });
  };
  return (
    <fieldset className="grid w-full gap-1.5 border-t border-line pt-3" disabled={busy}>
      <legend className="pb-1 text-[12.5px] text-muted">Workspaces that count in Kaizen OS (Next for me in Asana, the recap, your assistant)</legend>
      {spaces.map((s) => (
        <label key={s.gid} className={`flex min-h-11 items-center gap-3 rounded-[10px] px-2 text-[14px] md:min-h-9 ${s.locked ? "text-muted" : "cursor-pointer text-fg hover:bg-surface-2"}`}>
          <input type="checkbox" className="h-5 w-5 shrink-0 accent-[var(--brand)]" checked={s.locked || on.has(s.gid)} disabled={s.locked} onChange={() => toggle(s.gid)} />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {s.name}
            {s.locked && <span className="text-[12px] text-faint"> · always on</span>}
          </span>
        </label>
      ))}
      {error && <p className="text-[12.5px] text-bad">{error}</p>}
    </fieldset>
  );
}
