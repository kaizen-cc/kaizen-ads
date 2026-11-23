"use client";

import { useId, useState } from "react";
import { isEmail, type Channel, type Delivery, type Recipient } from "@/lib/reports/delivery-core";

// Where a report goes: Slack, email or both, and who the email goes to: To and Cc, the client's contacts one tap each,
// anyone past report emails went to ("sent to before"), or any address typed in (which can be saved as a contact).
// Remembered per client and service line once it's sent, so next week's report starts with the same people.

export type DeliveryOptions = {
  contacts: (Recipient & { primary: boolean })[];
  initial: Delivery;
  /** Addresses past report emails to this client went to that aren't on this one: one tap adds them */
  suggested?: Recipient[];
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
export function DeliveryPicker({
  value,
  onChange,
  options,
  disabled = false,
  channels: showChannels = true,
  onSaveContact,
}: {
  value: Delivery;
  onChange: (d: Delivery) => void;
  options: DeliveryOptions;
  disabled?: boolean;
  channels?: boolean;
  /** Saves a typed address as one of the client's contacts */
  onSaveContact?: (r: Recipient) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [typing, setTyping] = useState("");
  const [bad, setBad] = useState(false);
  const [addAs, setAddAs] = useState<"to" | "cc">("to");
  const [saving, setSaving] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const listId = useId();
  const cc = value.cc ?? [];
  const placeOf = (e: string): "to" | "cc" | null => (value.recipients.some((r) => r.email === e) ? "to" : cc.some((r) => r.email === e) ? "cc" : null);
  const set = (to: Recipient[], copy: Recipient[]) => onChange({ ...value, recipients: to.slice(0, 50), cc: copy.filter((r) => !to.some((t) => t.email === r.email)).slice(0, 20) });
  const drop = (e: string) => set(value.recipients.filter((r) => r.email !== e), cc.filter((r) => r.email !== e));
  const put = (r: Recipient, where: "to" | "cc") => {
    const to = value.recipients.filter((x) => x.email !== r.email);
    const copy = cc.filter((x) => x.email !== r.email);
    set(where === "to" ? [...to, r] : to, where === "cc" ? [...copy, r] : copy);
  };
  const move = (e: string) => {
    const r = [...value.recipients, ...cc].find((x) => x.email === e);
    if (r) put(r, placeOf(e) === "to" ? "cc" : "to");
  };
  const toggle = (c: Channel) => {
    const on = value.channels.includes(c);
    const channels = on ? value.channels.filter((x) => x !== c) : [...value.channels, c];
    onChange({ ...value, channels: channels.length ? channels : value.channels });
  };
  const add = () => {
    const parts = typing
      .split(/[\s,;]+/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    if (!parts.length) return;
    if (parts.some((x) => !isEmail(x))) return setBad(true);
    const known = new Map([...options.contacts, ...(options.suggested ?? [])].map((c) => [c.email, c.name ?? null]));
    let to = value.recipients.filter((r) => !parts.includes(r.email));
    let copy = cc.filter((r) => !parts.includes(r.email));
    const fresh = parts.map((e) => ({ email: e, name: known.get(e) ?? null }));
    if (addAs === "to") to = [...to, ...fresh];
    else copy = [...copy, ...fresh];
    set(to, copy);
    setTyping("");
    setBad(false);
  };
  const saveContact = async (r: Recipient) => {
    if (!onSaveContact) return;
    setSaving(r.email);
    setSaveError(null);
    const out = await onSaveContact(r).catch(() => ({ ok: false, error: "It couldn't be saved." }));
    setSaving(null);
    if (out.ok) setSavedNow((s) => new Set(s).add(r.email));
    else setSaveError(out.error ?? "It couldn't be saved.");
  };
  const extra = [...value.recipients, ...cc].filter((r) => !options.contacts.some((c) => c.email === r.email));
  const suggested = (options.suggested ?? []).filter((r) => !placeOf(r.email));
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
        <div className="grid gap-2.5">
          <span className={`text-[11px] font-semibold uppercase tracking-[0.14em] text-faint ${showChannels ? "" : "hidden"}`}>Email to</span>
          {/* The client's contacts, one tap each (picked = To; the small To/Cc switch moves them) */}
          {options.contacts.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {options.contacts.map((c) => {
                const where = placeOf(c.email);
                return (
                  <span key={c.email} className={`inline-flex min-h-10 max-w-full items-center rounded-full border text-[13px] transition-colors md:min-h-9 ${where ? "border-fg/50 bg-surface-2 text-fg" : "border-line text-muted hover:text-fg"}`}>
                    <button type="button" disabled={disabled} aria-pressed={Boolean(where)} onClick={() => (where ? drop(c.email) : put({ email: c.email, name: c.name ?? null }, "to"))} title={c.email} className="inline-flex min-w-0 items-center gap-2 py-1 pl-1.5 pr-2 text-left disabled:opacity-50">
                      <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${where ? "bg-fg text-bg" : "bg-ink/10"}`}>{where ? "✓" : (c.name ?? c.email).slice(0, 1).toUpperCase()}</span>
                      <span className="grid min-w-0 leading-tight">
                        <span className="truncate">{c.name ?? c.email}</span>
                        {c.name && <span className="truncate text-[11px] text-faint">{c.email}</span>}
                      </span>
                      {c.primary && <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">Main</span>}
                    </button>
                    {where && <PlaceToggle where={where} disabled={disabled} onFlip={() => move(c.email)} />}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-faint">No contacts on file for this client yet. Type an address below.</p>
          )}
          {/* Anyone else on it: typed in, or added from before */}
          {extra.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {extra.map((r) => (
                <span key={r.email} className="inline-flex min-h-10 max-w-full items-center gap-1 rounded-full border border-fg/50 bg-surface-2 py-1 pl-3 pr-1 text-[13px] md:min-h-9">
                  <span className="truncate">
                    {r.name ? `${r.name} · ` : ""}
                    {r.email}
                  </span>
                  <PlaceToggle where={placeOf(r.email) ?? "to"} disabled={disabled} onFlip={() => move(r.email)} />
                  {onSaveContact && !savedNow.has(r.email) && (
                    <button type="button" disabled={disabled || saving === r.email} onClick={() => void saveContact(r)} className="h-8 shrink-0 rounded-full px-2 text-[11.5px] text-brand-text hover:bg-brand/10 disabled:opacity-40 md:h-7">
                      {saving === r.email ? "Saving…" : "Save as contact"}
                    </button>
                  )}
                  {savedNow.has(r.email) && <span className="shrink-0 px-1 text-[11px] text-good">Saved</span>}
                  <button type="button" disabled={disabled} aria-label={`Remove ${r.email}`} onClick={() => drop(r.email)} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-faint hover:bg-surface hover:text-fg md:h-7 md:w-7">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* People past report emails to this client went to: one tap adds them */}
          {suggested.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11.5px] text-faint">Sent to before:</span>
              {suggested.map((r) => (
                <button key={r.email} type="button" disabled={disabled} onClick={() => put(r, "to")} title={r.email} className="inline-flex min-h-9 items-center gap-1 rounded-full border border-dashed border-line px-3 text-[12.5px] text-muted hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-8">
                  + {r.name ?? r.email}
                </button>
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
              list={listId}
              value={typing}
              disabled={disabled}
              onChange={(e) => {
                setTyping(e.target.value);
                setBad(false);
              }}
              onBlur={() => typing.trim() && add()}
              placeholder={addAs === "cc" ? "Copy someone (Cc)" : "Add someone (To)"}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none md:h-9"
            />
            <datalist id={listId}>
              {[...options.contacts, ...(options.suggested ?? [])].map((c) => (
                <option key={c.email} value={c.email}>
                  {c.name ?? ""}
                </option>
              ))}
            </datalist>
            <div role="group" aria-label="Add as" className="flex shrink-0 rounded-[9px] border border-line p-0.5 text-[12px]">
              {(["to", "cc"] as const).map((k) => (
                <button key={k} type="button" aria-pressed={addAs === k} onMouseDown={(e) => e.preventDefault()} onClick={() => setAddAs(k)} className={`h-9 rounded-[7px] px-2.5 md:h-7 ${addAs === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                  {k === "to" ? "To" : "Cc"}
                </button>
              ))}
            </div>
            <button type="submit" disabled={disabled || !typing.trim()} className="h-10 shrink-0 rounded-[9px] bg-fg px-3.5 text-[13px] text-bg disabled:opacity-40 md:h-8">
              Add
            </button>
          </form>
          {bad && <p className="text-[11.5px] text-bad">That doesn&rsquo;t look like an email address.</p>}
          {!value.recipients.length && <p className="text-[11.5px] text-warn">Pick at least one person to email.</p>}
          {saveError && <p className="text-[11.5px] text-bad">{saveError}</p>}
          <p className="text-[11.5px] leading-snug text-faint">From the agency&rsquo;s address with the PDF attached; replies come to you, and the team is copied too. Remembered for this client&rsquo;s reports on this line.</p>
        </div>
      )}
    </div>
  );
}

/** Whether someone gets it as To or as a copy (Cc): one tap switches */
function PlaceToggle({ where, disabled, onFlip }: { where: "to" | "cc"; disabled?: boolean; onFlip: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onFlip} title={where === "to" ? "Move to Cc" : "Move to To"} className="mr-1 h-8 shrink-0 rounded-full border border-line px-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted hover:text-fg disabled:opacity-40 md:h-7">
      {where === "to" ? "To" : "Cc"}
    </button>
  );
}
