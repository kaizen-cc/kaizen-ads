"use client";

import { useState, useTransition } from "react";
import type { EmailMode, GroupKey, NoticePrefs } from "@/lib/notifications";
import { saveNoticePrefs } from "../notification-actions";

const EMAIL: [EmailMode, string][] = [
  ["off", "No email"],
  ["critical", "Critical only"],
  ["all", "Everything"],
];

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-[''] md:after:hidden ${on ? "bg-brand" : "bg-surface-2 ring-1 ring-inset ring-line"}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-[22px]" : "translate-x-0.5"}`} />
    </button>
  );
}

export function NoticeSettings({ initial, groups, email }: { initial: NoticePrefs; groups: { key: GroupKey; label: string; about: string }[]; email: string | null }) {
  const [prefs, setPrefs] = useState(initial);
  const [saving, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const save = (next: NoticePrefs) => {
    setPrefs(next);
    start(async () => {
      const r = await saveNoticePrefs(next);
      setNote(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: r.error });
      if (r.ok) setTimeout(() => setNote(null), 1400);
    });
  };
  const setGroup = (k: GroupKey, patch: Partial<NoticePrefs["groups"][GroupKey]>) => save({ ...prefs, groups: { ...prefs.groups, [k]: { ...prefs.groups[k], ...patch } } });

  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between gap-3 text-xs text-faint">
        <span className="min-w-0 break-words">{email ? `Email goes to ${email}` : "No email address on your profile"}</span>
        <span className={note ? (note.ok ? "text-ok" : "text-bad") : ""}>{saving ? "Saving…" : (note?.text ?? "")}</span>
      </div>

      <ul className="divide-y divide-line overflow-hidden rounded-[18px] border border-line bg-surface">
        {groups.map((g) => {
          const v = prefs.groups[g.key];
          const recap = g.key === "recap";
          return (
            <li key={g.key} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div className="flex items-start gap-3">
                <Toggle on={v.app} onChange={(on) => setGroup(g.key, { app: on })} label={`${g.label} on or off`} />
                <div className="grid min-w-0 gap-0.5">
                  <p className={`text-[15px] font-medium ${v.app ? "" : "text-muted"}`}>{g.label}</p>
                  <p className="text-xs text-muted">{g.about}</p>
                </div>
              </div>
              {!recap && (
                <div className={`flex w-full rounded-full border border-line bg-bg p-0.5 text-xs md:w-auto ${v.app ? "" : "pointer-events-none opacity-40"}`} aria-label={`Email for ${g.label}`}>
                  {EMAIL.map(([mode, label]) => (
                    <button key={mode} type="button" onClick={() => setGroup(g.key, { email: mode })} className={`flex-1 rounded-full px-3 py-2.5 transition-colors md:flex-none md:py-1.5 ${v.email === mode ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
                      {label}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <div className="flex items-start gap-3 rounded-[18px] border border-line bg-surface px-5 py-4">
        <Toggle on={prefs.popups} onChange={(on) => save({ ...prefs, popups: on })} label="Pop-ups for critical notifications" />
        <div className="grid gap-0.5">
          <p className="text-[15px] font-medium">Pop-ups for critical ones</p>
          <p className="text-xs text-muted">Something critical that arrives while you&apos;re in Kaizen Ads shows bottom-right as well as in the bell.</p>
        </div>
      </div>

      <p className="text-xs text-faint">
        Turning a group off stops it in the bell and by email. Your daily recap still shows everything that needs you; these settings are about what interrupts you during the day.
      </p>
    </div>
  );
}
