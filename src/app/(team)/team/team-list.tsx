"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import { ROLES, TEAMS, TIERS, canAlsoDesignEmail, extraTeams, homeTeam, roleLabel, teamsOfferedFor, tierOf, type Team, type TeamRole, type Tier } from "@/lib/roles";
import { invitePerson, sendInvite, setActive, setRole, setSwitch, setTeams } from "./actions";

export type Person = {
  id: string;
  email: string;
  fullName: string;
  role: TeamRole;
  isActive: boolean;
  /** A creative who also works on organic social */
  alsoSocial?: boolean;
  /** An email builder who also designs email */
  alsoDesignsEmail?: boolean;
  /** The other teams they work on (ads, email, social), beyond their role's own */
  teams?: string[];
  joined: boolean;
  invitedAt?: string | null;
  clientCount: number;
  /** Execs only: when they were last on and how much they use Kaizen OS */
  usage?: { lastActive: string | null; lastSignIn: string | null; perWeek: string | null; thisWeek: string | null } | null;
};

const select = "h-11 min-w-0 rounded-[8px] border border-line bg-bg px-3 text-sm outline-none transition-colors hover:border-faint/60 focus:border-brand-text/70 md:h-10";

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

const TEAM_TONE: Record<Team, string> = {
  ads: "bg-brand-soft text-brand-text",
  email: "bg-warn-soft text-warn",
  social: "bg-[#8b5cf6]/15 text-[#a78bfa]",
};

/**
 * The teams someone works on, as badges: their role's own team first (fixed), then any others they also work on, each
 * removable, and "+ Team" to add one (an exec; only the teams that mean something for their position). An email
 * builder who also designs email has a "Designs email" badge the same way.
 */
function TeamBadges({ p, canEdit, run, pending }: { p: Person; canEdit: boolean; run: (fn: () => Promise<{ ok: true } | { ok: false; error: string }>) => void; pending: boolean }) {
  const home = homeTeam(p.role);
  const offered = teamsOfferedFor(p.role);
  const [extra, setExtra] = useState<Team[]>(() => [...extraTeams({ teams: p.teams, also_social: p.alsoSocial })].filter((t) => offered.includes(t)));
  const [designs, setDesigns] = useState(Boolean(p.alsoDesignsEmail));
  const [adding, setAdding] = useState(false);
  const builder = canAlsoDesignEmail(p.role);
  if (!home && !offered.length) return null;
  const save = (next: Team[]) => {
    setExtra(next);
    setAdding(false);
    run(() => setTeams(p.id, next));
  };
  const toAdd = offered.filter((t) => !extra.includes(t));
  const label = (t: Team) => TEAMS.find((x) => x.value === t)!.label;
  const chip = "inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-[11px] font-medium sm:min-h-6";
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5" aria-label={`Teams ${p.fullName} works on`}>
      {home && <span className={`${chip} ${TEAM_TONE[home]}`}>{label(home)}</span>}
      {extra.map((t) => (
        <span key={t} className={`${chip} ${TEAM_TONE[t]}`}>
          {label(t)}
          {canEdit && (
            <button type="button" disabled={pending} onClick={() => save(extra.filter((x) => x !== t))} aria-label={`Take ${p.fullName} off the ${label(t)} team`} className="-mr-1 grid h-6 w-6 place-items-center rounded-full opacity-70 hover:opacity-100 sm:h-4 sm:w-4">
              ×
            </button>
          )}
        </span>
      ))}
      {builder && (designs || canEdit) && (
        <button
          type="button"
          disabled={!canEdit || pending}
          aria-pressed={designs}
          onClick={() => {
            const next = !designs;
            setDesigns(next);
            run(() => setSwitch(p.id, "also_designs_email", next));
          }}
          className={`${chip} ${designs ? TEAM_TONE.email : "border border-dashed border-line text-faint hover:text-fg"}`}
        >
          {designs ? "Designs email" : "+ Designs email"}
        </button>
      )}
      {canEdit && toAdd.length > 0 &&
        (adding ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            {toAdd.map((t) => (
              <button key={t} type="button" disabled={pending} onClick={() => save([...extra, t])} className={`${chip} border border-line text-muted hover:border-faint hover:text-fg`}>
                + {label(t)}
              </button>
            ))}
            <button type="button" onClick={() => setAdding(false)} className={`${chip} text-faint hover:text-fg`}>
              Cancel
            </button>
          </span>
        ) : (
          <button type="button" onClick={() => setAdding(true)} className={`${chip} border border-dashed border-line text-faint hover:text-fg`}>
            + Team
          </button>
        ))}
    </div>
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
    <li className={`grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 px-4 py-3.5 sm:gap-y-2 sm:py-3 sm:grid-cols-[auto_1fr_200px_110px] ${p.isActive && p.joined ? "" : "opacity-55"}`}>
      <PersonAvatar name={p.fullName} muted={!p.isActive || !p.joined} link />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-medium sm:flex-nowrap sm:truncate">
          <Link href={`/profile/${p.id}`} className="hover:underline">
            {p.fullName}
          </Link>{" "}
          {isMe && <span className="text-xs font-normal text-faint">(you)</span>}
          {p.isActive &&
            (p.joined ? (
              <span className="rounded-full bg-ok-soft px-1.5 py-px text-[10px] font-normal text-ok">Active</span>
            ) : (
              <span className="rounded-full border border-line px-1.5 py-px text-[10px] font-normal text-faint">
                {p.invitedAt ? `Invited ${new Date(p.invitedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Not joined yet"}
              </span>
            ))}
        </p>
        <p className="text-xs text-muted [overflow-wrap:anywhere] sm:truncate">
          {p.email}
          {p.clientCount > 0 && <span className="text-faint"> · {p.clientCount} clients</span>}
        </p>
        <TeamBadges p={p} canEdit={canEdit} run={run} pending={pending} />
        {p.usage && p.joined && (
          <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-faint">
            <span className="inline-flex items-center gap-1.5">
              <span className={`h-1.5 w-1.5 rounded-full ${p.usage.lastActive === "now" ? "bg-ok" : "bg-faint/60"}`} />
              {p.usage.lastActive ? (p.usage.lastActive === "now" ? "Active now" : `Last active ${p.usage.lastActive}`) : "No activity yet"}
            </span>
            {p.usage.lastSignIn && <span>· Signed in {p.usage.lastSignIn}</span>}
            {p.usage.perWeek && <span>· ~{p.usage.perWeek} a week</span>}
            {p.usage.thisWeek && <span>· {p.usage.thisWeek} this week</span>}
            <Link href={`/team/${p.id}`} className="inline-flex min-h-11 items-center text-muted underline-offset-2 hover:text-fg hover:underline sm:min-h-0">
              Activity →
            </Link>
          </p>
        )}
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
      <div className="col-span-2 flex items-center justify-between gap-2 max-sm:empty:hidden sm:col-span-1 sm:justify-end">
        {note ? (
          <span className={`min-w-0 text-xs [overflow-wrap:anywhere] ${note.ok ? "text-ok" : "text-brand-text"}`}>{note.text}</span>
        ) : canEdit && !isMe ? (
          <span className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-col sm:flex-nowrap sm:items-end sm:gap-1">
            {p.isActive && !p.joined && (
              <button
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const res = await sendInvite(p.id);
                    setNote(res.ok ? { ok: true, text: "Invite sent" } : { ok: false, text: res.error });
                    if (res.ok) setTimeout(() => setNote(null), 2500);
                  })
                }
                className="h-11 flex-1 rounded-full bg-brand px-4 text-xs font-medium text-white hover:bg-brand-hover disabled:opacity-60 sm:h-auto sm:flex-none sm:px-3 sm:py-1"
                title={p.invitedAt ? `Last sent ${new Date(p.invitedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Emails them a link to sign in with Google"}
              >
                {pending ? "Sending…" : p.invitedAt ? "Resend invite" : "Send invite"}
              </button>
            )}
            <button disabled={pending} onClick={() => run(() => setActive(p.id, !p.isActive))} className="h-11 rounded-full border border-line px-4 text-xs text-muted hover:text-fg max-sm:ml-auto sm:h-auto sm:border-0 sm:px-0">
              {p.isActive ? "Deactivate" : "Reactivate"}
            </button>
          </span>
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
          setNote(res.ok ? { ok: true, text: "Added. Their accounts follow the sheet from the next run. No email went out; send the invite when they're ready." } : { ok: false, text: res.error });
          if (res.ok) formEl.reset();
        });
      }}
      className="grid gap-3 rounded-[12px] border border-line bg-surface p-4 md:p-5"
    >
      <div>
        <p className="text-sm font-medium">Add a teammate</p>
        <p className="mt-0.5 text-xs text-faint">Adds them to the team (accounts, KPIs, assignments) without emailing them. Send the invite from their row when they&apos;re ready.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-[1fr_1.4fr_200px_auto]">
        <input name="full_name" required placeholder="Name" aria-label="Name" className={select} />
        <input name="email" type="email" required placeholder="name@kaizenmarketing.agency" aria-label="Email" className={select} />
        <select name="role" defaultValue="media_buyer" aria-label="Role" className={select}>
          <RoleOptions />
        </select>
        <button disabled={pending} className="h-11 rounded-[8px] bg-brand px-5 md:h-10 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60">
          {pending ? "Adding…" : "Add"}
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
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
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
        <button onClick={() => setShowInactive((s) => !s)} className="min-h-11 justify-self-start text-xs text-muted hover:text-fg md:min-h-0">
          {showInactive ? "Hide" : "Show"} {inactiveCount} deactivated
        </button>
      )}
    </div>
  );
}
