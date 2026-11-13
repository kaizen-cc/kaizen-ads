"use client";

import { useState } from "react";
import { isEmail, type Channel, type Delivery, type Recipient } from "@/lib/reports/delivery-core";

// Where a report goes: Slack, email or both, and who the email goes to (the client's contacts, one tap each, or any
// address typed in). Remembered per client once it's sent, so the next report starts the same way.

export type DeliveryOptions = {
  contacts: (Recipient & { primary: boolean })[];
  initial: Delivery;
  slackChannel: boolean;
  emailReady: boolean;
};

const CHANNELS: { key: Channel; label: string; icon: React.ReactNode }[] = [
  {
    key: "slack",
    label: "Slack",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M5.04 15.17a2.53 2.53 0 1 1-2.52-2.52h2.52zm1.27 0a2.53 2.53 0 0 1 5.05 0v6.31a2.53 2.53 0 1 1-5.05 0zM8.83 5.04a2.53 2.53 0 1 1 2.53-2.52v2.52zm0 1.27a2.53 2.53 0 0 1 0 5.05H2.52a2.53 2.53 0 0 1 0-5.05zM18.96 8.83a2.53 2.53 0 1 1 2.52 2.53h-2.52zm-1.27 0a2.53 2.53 0 0 1-5.05 0V2.52a2.53 2.53 0 0 1 5.05 0zM15.17 18.96a2.53 2.53 0 1 1-2.53 2.52v-2.52zm0-1.27a2.53 2.53 0 0 1 0-5.05h6.31a2.53 2.53 0 0 1 0 5.05z" />
      </svg>
    ),
  },
  {
    key: "email",
    label: "Email",
    icon: (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    ),
  },
];

/** `channels: false`: only who the email goes to (the studio's send step picks Slack and email on its own cards) */
export function DeliveryPicker({ value, onChange, options, disabled = false, channels: showChannels = true }: { value: Delivery; onChange: (d: Delivery) => void; options: DeliveryOptions; disabled?: boolean; channels?: boolean }) {
  const [typing, setTyping] = useState("");
  const [bad, setBad] = useState(false);
  const toggle = (c: Channel) => {
    const on = value.channels.includes(c);
    const channels = on ? value.channels.filter((x) => x !== c) : [...value.channels, c];
    onChange({ ...value, channels: channels.length ? channels : value.channels });
  };
  const picked = (email: string) => value.recipients.some((r) => r.email === email);
  const flip = (r: Recipient) => onChange({ ...value, recipients: picked(r.email) ? value.recipients.filter((x) => x.email !== r.email) : [...value.recipients, { email: r.email, name: r.name ?? null }] });
  const add = () => {
    const parts = typing.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return;
    if (parts.some((x) => !isEmail(x))) return setBad(true);
    const known = new Map(options.contacts.map((c) => [c.email, c.name]));
    const next = [...value.recipients];
    for (const e of parts) if (!next.some((r) => r.email === e)) next.push({ email: e, name: known.get(e) ?? null });
    onChange({ ...value, recipients: next.slice(0, 10) });
    setTyping("");
    setBad(false);
  };
  const extra = value.recipients.filter((r) => !options.contacts.some((c) => c.email === r.email));
  const email = value.channels.includes("email");

  return (
    <div className="grid gap-3">
      <div className={`grid gap-1.5 ${showChannels ? "" : "hidden"}`}>
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Send by</span>
        <div className="grid grid-cols-2 gap-1.5" role="group" aria-label="Send by">
          {CHANNELS.map((c) => {
            const on = value.channels.includes(c.key);
            return (
              <button
                key={c.key}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() => toggle(c.key)}
                className={`flex h-12 items-center justify-center gap-2 rounded-[14px] border text-sm transition-all disabled:opacity-50 md:h-11 ${on ? "border-brand/60 bg-brand/[0.1] text-fg shadow-[0_10px_30px_-20px_rgba(200,16,46,0.9)]" : "border-line text-muted hover:border-faint hover:text-fg"}`}
              >
                {c.icon}
                {c.label}
                <span className={`grid h-4 w-4 place-items-center rounded-full text-[10px] ${on ? "bg-brand text-white" : "border border-line"}`}>{on ? "✓" : ""}</span>
              </button>
            );
          })}
        </div>
        {value.channels.includes("slack") && !options.slackChannel && <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-xs text-warn">No Slack channel is linked for this client. Add it on the client page, or send by email.</p>}
        {email && !options.emailReady && <p className="rounded-[10px] bg-warn-soft px-3 py-2 text-xs text-warn">Email isn&rsquo;t set up yet (RESEND_API_KEY). Send by Slack for now.</p>}
      </div>

      {email && (
        <div className="grid gap-1.5">
          <span className={`text-[11px] font-semibold uppercase tracking-[0.14em] text-faint ${showChannels ? "" : "hidden"}`}>Email to</span>
          {options.contacts.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {options.contacts.map((c) => {
                const on = picked(c.email);
                return (
                  <button
                    key={c.email}
                    type="button"
                    disabled={disabled}
                    aria-pressed={on}
                    onClick={() => flip(c)}
                    title={c.email}
                    className={`inline-flex min-h-10 max-w-full items-center gap-2 rounded-full border py-1 pl-1.5 pr-3 text-left text-[13px] transition-colors disabled:opacity-50 md:min-h-9 ${on ? "border-fg/50 bg-surface-2 text-fg" : "border-line text-muted hover:text-fg"}`}
                  >
                    <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${on ? "bg-fg text-bg" : "bg-ink/10"}`}>{on ? "✓" : (c.name ?? c.email).slice(0, 1).toUpperCase()}</span>
                    <span className="grid min-w-0 leading-tight">
                      <span className="truncate">{c.name ?? c.email}</span>
                      {c.name && <span className="truncate text-[11px] text-faint">{c.email}</span>}
                    </span>
                    {c.primary && <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">Main</span>}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-faint">No contacts on file for this client yet. Type an address below.</p>
          )}
          {extra.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {extra.map((r) => (
                <span key={r.email} className="inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-full border border-fg/50 bg-surface-2 py-1 pl-3 pr-1 text-[13px]">
                  <span className="truncate">{r.email}</span>
                  <button type="button" disabled={disabled} aria-label={`Remove ${r.email}`} onClick={() => flip(r)} className="grid h-8 w-8 place-items-center rounded-full text-faint hover:bg-surface hover:text-fg md:h-7 md:w-7">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
            className={`flex items-center gap-1.5 rounded-[12px] border bg-bg p-1 pl-3 ${bad ? "border-bad/60" : "border-line focus-within:border-brand-text/60"}`}
          >
            <input
              type="email"
              inputMode="email"
              autoComplete="off"
              value={typing}
              disabled={disabled}
              onChange={(e) => {
                setTyping(e.target.value);
                setBad(false);
              }}
              onBlur={() => typing.trim() && add()}
              placeholder="Add an address"
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none md:h-9"
            />
            <button type="submit" disabled={disabled || !typing.trim()} className="h-10 shrink-0 rounded-[9px] bg-fg px-3.5 text-[13px] text-bg disabled:opacity-40 md:h-8">
              Add
            </button>
          </form>
          {bad && <p className="text-[11.5px] text-bad">That doesn&rsquo;t look like an email address.</p>}
          {!value.recipients.length && <p className="text-[11.5px] text-warn">Pick at least one person to email.</p>}
          <p className="text-[11.5px] leading-snug text-faint">From the agency&rsquo;s address with the PDF attached; replies come to you. Remembered for this client.</p>
        </div>
      )}
    </div>
  );
}
