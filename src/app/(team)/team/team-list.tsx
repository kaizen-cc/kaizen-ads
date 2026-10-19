"use client";

import { useState, useTransition } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import { ROLES, TIERS, roleLabel, tierOf, type TeamRole, type Tier } from "@/lib/roles";
import { invitePerson, setActive, setRole } from "./actions";

export type Person = {
  id: string;
  email: string;
  fullName: string;
  role: TeamRole;
  isActive: boolean;
  joined: boolean;
  clientCount: number;
};

const select = "h-10 rounded-[8px] border border-line bg-bg px-3 text-sm outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70";

function RoleOptions() {
  return (
    <>
      {TIERS.map((t) => (
        <optgroup key={t.value} label={t.label}>
          {ROLES.filter((r) => r.tier === t.value).map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

function Row({ p, canEdit, isMe }: { p: Person; canEdit: boolean; isMe: boolean }) {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      const res = await fn();
      setNote(res.ok ? { ok: true, text: "Saved" } : { ok: false, text: res.error });
      if (res.ok) setTimeout(() => setNote(null), 1500);
    });

  return (
    <li className={`grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 px-4 py-3 sm:grid-cols-[auto_1fr_200px_110px] ${p.isActive && p.joined ? "" : "opacity-55"}`}>
      <PersonAvatar name={p.fullName} muted={!p.isActive || !p.joined} />
      <div className="min-w-0">
        <p className="flex items-center gap-2 truncate text-sm font-medium">
          {p.fullName} {isMe && <span className="text-xs font-normal text-faint">(you)</span>}
          {p.isActive && (p.joined ? <span className="rounded-full bg-ok-soft px-1.5 py-px text-[10px] font-normal text-ok">Active</span> : <span className="rounded-full border border-line px-1.5 py-px text-[10px] font-normal text-faint">Not joined yet</span>)}
        </p>
        <p className="truncate text-xs text-muted">
          {p.email}
          {p.clientCount > 0 && <span className="text-faint"> · {p.clientCount} clients</span>}
        </p>
      </div>
      <div className="col-span-2 flex items-center gap-2 sm:col-span-1">
        {canEdit ? (
          <select
            aria-label={`Role for ${p.fullName}`}
            defaultValue={p.role}
            disabled={pending}
            onChange={(e) => run(() => setRole(p.id, e.target.value))}
            className={`${select} w-full`}
          >
            <RoleOptions />
          </select>
        ) : (
          <span className="text-sm text-muted">{roleLabel(p.role)}</span>
        )}
      </div>
      <div className="col-span-2 flex items-center justify-between gap-2 sm:col-span-1 sm:justify-end">
        {note ? (
          <span className={`text-xs ${note.ok ? "text-ok" : "text-brand-text"}`}>{note.text}</span>
        ) : canEdit && !isMe ? (
          <button
            disabled={pending}
            onClick={() => run(() => setActive(p.id, !p.isActive))}
            className="text-xs text-muted hover:text-fg"
          >
            {p.isActive ? "Deactivate" : "Reactivate"}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function Invite() {
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formEl = e.currentTarget;
        const data = new FormData(formEl);
        start(async () => {
          const res = await invitePerson(data);
          setNote(res.ok ? { ok: true, text: "Invited. They can sign in with Google now." } : { ok: false, text: res.error });
          if (res.ok) formEl.reset();
        });
      }}
      className="grid gap-3 rounded-[12px] border border-line bg-surface p-5"
    >
      <p className="text-sm font-medium">Invite a teammate</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr_200px_auto]">
        <input name="full_name" required placeholder="Name" aria-label="Name" className={select} />
        <input name="email" type="email" required placeholder="name@kaizenmarketing.agency" aria-label="Email" className={select} />
        <select name="role" defaultValue="media_buyer" aria-label="Role" className={select}>
          <RoleOptions />
        </select>
        <button disabled={pending} className="h-10 rounded-[8px] bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60">
          {pending ? "Inviting…" : "Invite"}
        </button>
      </div>
      {note && <p className={`text-xs ${note.ok ? "text-ok" : "text-brand-text"}`}>{note.text}</p>}
    </form>
  );
}

export function TeamList({ people, canEdit, meId }: { people: Person[]; canEdit: boolean; meId: string }) {
  const [showInactive, setShowInactive] = useState(false);
  const visible = people.filter((p) => showInactive || p.isActive);
  const inactiveCount = people.filter((p) => !p.isActive).length;
  const joined = people.filter((p) => p.isActive && p.joined).length;
  const waiting = people.filter((p) => p.isActive && !p.joined).length;

  return (
    <div className="grid gap-6">
      {canEdit && <Invite />}
      <p className="text-xs text-muted">
        <span className="text-ok">{joined} active</span> · {waiting} not joined yet. Someone becomes active the first time they sign in; until then they get no notifications or daily recap.
      </p>
      {TIERS.map((t) => {
        // Active (signed in) first, then those who haven't joined yet
        const group = visible.filter((p) => tierOf(p.role) === (t.value as Tier)).sort((a, b) => Number(b.joined) - Number(a.joined) || a.fullName.localeCompare(b.fullName));
        if (!group.length) return null;
        return (
          <section key={t.value} className="grid gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-heading text-lg">
                {t.label} <span className="text-sm text-faint">{group.length}</span>
              </h2>
              <p className="text-xs text-muted">{t.access}</p>
            </div>
            <ul className="divide-y divide-line overflow-hidden rounded-brand border border-line bg-surface">
              {group.map((p) => (
                <Row key={p.id} p={p} canEdit={canEdit} isMe={p.id === meId} />
              ))}
            </ul>
          </section>
        );
      })}
      {inactiveCount > 0 && (
        <button onClick={() => setShowInactive((s) => !s)} className="justify-self-start text-xs text-muted hover:text-fg">
          {showInactive ? "Hide" : "Show"} {inactiveCount} deactivated
        </button>
      )}
    </div>
  );
}
