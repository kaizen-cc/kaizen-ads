"use client";

import { useState, useTransition } from "react";
import { CONSENT_TEXT, prettyPhone } from "@/lib/phone-core";
import { savePhoneSettings, testPhoneCall, type PhoneForm } from "./phone-actions";

// Settings › Phone alerts: your own number, consent, quiet hours and a test call. Everything saves as you change it.

type Recent = { id: string; title: string; status: string; kind: string; at: string; digits: string | null };
const ZONES: [string, string][] = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
  ["America/Mexico_City", "Mexico City"],
  ["America/Bogota", "Bogotá"],
  ["America/Sao_Paulo", "São Paulo"],
  ["Europe/London", "London"],
  ["Europe/Madrid", "Madrid"],
  ["Europe/Athens", "Athens"],
  ["Asia/Karachi", "Karachi"],
  ["Asia/Kolkata", "India"],
  ["Asia/Manila", "Manila"],
];
const hourLabel = (h: number) => (h === 0 ? "12am" : h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`);
const when = (iso: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

export function PhoneAlerts({ initial, configured, readOnly, recent }: { initial: PhoneForm; configured: boolean; readOnly: boolean; recent: Recent[] }) {
  const [f, setF] = useState<PhoneForm>(initial);
  const [phone, setPhone] = useState(initial.phone ? prettyPhone(initial.phone) : "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = (next: PhoneForm) =>
    start(async () => {
      const r = await savePhoneSettings(next);
      if (r.ok) {
        setF({ ...next, phone: r.phone ?? "" });
        if (r.phone) setPhone(prettyPhone(r.phone));
        setMsg({ ok: true, text: "Saved." });
      } else setMsg({ ok: false, text: r.error });
    });
  const field = "h-11 rounded-xl border border-line bg-surface px-3 text-[15px] text-fg disabled:opacity-60 md:h-9 md:text-sm";
  return (
    <div className="grid max-w-2xl gap-5">
      <header>
        <h2 className="font-heading text-[20px] leading-tight">Phone alerts</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
          When something urgent for you sits unseen for 10 minutes, Kaizen OS can call your phone with a short spoken notice: press 1 to hear it (and get the link by text), 2 to snooze it an hour. Only critical items, at most three calls an hour,
          never in your quiet hours. Off unless you turn it on.
        </p>
      </header>
      {!configured && <p className="rounded-2xl border border-line bg-surface p-4 text-[13px] text-muted">Phone calls aren&apos;t switched on for Kaizen yet. You can set this up now; calls start once they are.</p>}
      <section className="grid gap-4 rounded-[22px] border border-line p-4 sm:p-5">
        <label className="grid gap-1.5">
          <span className="text-[13px] font-medium">Your mobile number</span>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            disabled={readOnly || pending}
            value={phone}
            placeholder="(512) 555-0134"
            onChange={(e) => setPhone(e.target.value)}
            onBlur={() => phone.trim() !== (f.phone ? prettyPhone(f.phone) : "") && save({ ...f, phone, consent: f.optedIn })}
            className={field}
          />
          <span className="text-[12px] text-faint">US numbers as you&apos;d dial them; anywhere else with its country code (+44…).</span>
        </label>
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            disabled={readOnly || pending}
            checked={f.consent || f.optedIn}
            onChange={(e) => (e.target.checked ? setF({ ...f, consent: true }) : save({ ...f, phone, consent: false, optedIn: false }))}
            className="mt-1 h-5 w-5 shrink-0 accent-[var(--color-brand)]"
          />
          <span className="text-[13px] leading-relaxed text-muted">{CONSENT_TEXT}</span>
        </label>
        <label className="flex min-h-11 items-center justify-between gap-3">
          <span className="text-[14px] font-medium">Call me for urgent items</span>
          <input
            type="checkbox"
            role="switch"
            disabled={readOnly || pending || (!f.optedIn && !(f.consent && phone.trim()))}
            checked={f.optedIn}
            onChange={(e) => save({ ...f, phone, optedIn: e.target.checked, consent: e.target.checked ? f.consent : f.consent })}
            className="h-6 w-6 accent-[var(--color-brand)]"
          />
        </label>
        <div className="grid gap-1.5">
          <span className="text-[13px] font-medium">Quiet hours</span>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-[auto_auto_1fr] sm:items-center">
            <select aria-label="Quiet from" disabled={readOnly || pending} value={f.quietStart} onChange={(e) => save({ ...f, phone, quietStart: Number(e.target.value) })} className={field}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  From {hourLabel(h)}
                </option>
              ))}
            </select>
            <select aria-label="Quiet until" disabled={readOnly || pending} value={f.quietEnd} onChange={(e) => save({ ...f, phone, quietEnd: Number(e.target.value) })} className={field}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  Until {hourLabel(h)}
                </option>
              ))}
            </select>
            <select aria-label="Time zone" disabled={readOnly || pending} value={f.timezone} onChange={(e) => save({ ...f, phone, timezone: e.target.value })} className={`${field} col-span-2 sm:col-span-1`}>
              {ZONES.map(([z, label]) => (
                <option key={z} value={z}>
                  {label} time
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={readOnly || pending || !f.optedIn || !configured}
            onClick={() =>
              start(async () => {
                const r = await testPhoneCall();
                setMsg(r.ok ? { ok: true, text: "Calling you now." } : { ok: false, text: r.error });
              })
            }
            className="inline-flex min-h-11 items-center rounded-full bg-brand px-4 text-[13.5px] font-medium text-white transition hover:bg-brand-hover active:scale-[0.97] disabled:opacity-40 md:min-h-9"
          >
            Test call
          </button>
          {msg && (
            <p role="status" className={`text-[13px] ${msg.ok ? "text-ok" : "text-bad"}`}>
              {msg.text}
            </p>
          )}
        </div>
      </section>
      {recent.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-[11px] uppercase tracking-[0.16em] text-muted">Recent calls</h3>
          <ul className="grid gap-1.5">
            {recent.map((c) => (
              <li key={c.id} className="flex items-baseline justify-between gap-3 rounded-xl bg-surface px-3.5 py-2.5 text-[13px]">
                <span className="min-w-0 truncate">{c.kind === "test" ? "Test call" : c.title}</span>
                <span className="shrink-0 text-[12px] text-muted">
                  {when(c.at)} · {c.status.replace(/-/g, " ")}
                  {c.digits === "2" ? " · snoozed" : c.digits === "1" ? " · heard" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
