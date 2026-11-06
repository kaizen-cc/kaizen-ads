"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { bibleAvatars } from "@/app/(team)/quick-brief-actions";
import { matchAvatar, type BibleAvatar } from "@/lib/bible-sections";

// Avatar vs angle, on every brief form (the quick preview, Ready to send, the request form): the avatar is WHO, picked
// from the client's Brand Bible (its audience profiles), or "Other (test a new avatar)", which marks the request as an
// avatar test. The angle stays free text. Both go on the ticket, the board card and the Asana task, so creatives can
// name files and folders by avatar and angle.

const OTHER = "__other__";
const lists = new Map<string, BibleAvatar[]>();
const loading = new Set<string>();
const subs = new Set<() => void>();
let tick = 0;
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** The client's Bible avatars (read once per client per page); null while they're read */
export function useBibleAvatars(clientId: string | null | undefined, given?: BibleAvatar[] | null): BibleAvatar[] | null {
  useSyncExternalStore(subscribe, () => tick, () => 0);
  useEffect(() => {
    if (!clientId || given || lists.has(clientId) || loading.has(clientId)) return;
    loading.add(clientId);
    bibleAvatars(clientId)
      .catch(() => [] as BibleAvatar[])
      .then((list) => {
        lists.set(clientId, list);
        loading.delete(clientId);
        tick++;
        subs.forEach((f) => f());
      });
  }, [clientId, given]);
  if (given) return given;
  return clientId ? (lists.get(clientId) ?? null) : [];
}

export type AvatarValue = { avatar: string; avatarTest: boolean };

/**
 * One dropdown: the Bible's avatars, then "Other (test a new avatar)" with a short name for it. A name that isn't in the
 * Bible (an older brief, the AI's guess) shows as a test only once someone picks it; until then it asks for a pick.
 */
export function AvatarField({
  clientId,
  value,
  onChange,
  avatars: given,
  id,
  compact = false,
}: {
  clientId: string | null | undefined;
  value: AvatarValue;
  onChange: (v: AvatarValue) => void;
  avatars?: BibleAvatar[] | null;
  id?: string;
  compact?: boolean;
}) {
  const avatars = useBibleAvatars(clientId, given);
  const hit = avatars ? matchAvatar(avatars, value.avatar) : null;
  const [other, setOther] = useState(value.avatarTest);
  const testing = other || value.avatarTest;
  const selected = testing ? OTHER : (hit?.name ?? "");
  const chosen = hit && !testing ? hit : null;
  return (
    <div className="grid min-w-0 gap-2">
      <div className="relative">
        <select
          id={id}
          value={selected}
          disabled={avatars === null}
          onChange={(e) => {
            const v = e.target.value;
            if (v === OTHER) {
              setOther(true);
              onChange({ avatar: hit ? "" : value.avatar, avatarTest: true });
            } else {
              setOther(false);
              onChange({ avatar: v, avatarTest: false });
            }
          }}
          aria-label="Avatar"
          className={`w-full appearance-none rounded-[12px] border bg-bg/60 pl-3.5 pr-10 text-[16px] outline-none transition-colors focus:border-brand/60 md:text-[14px] ${compact ? "h-11" : "h-12"} ${selected ? "border-line text-fg" : "border-warn/50 text-muted"}`}
        >
          <option value="" disabled>
            {avatars === null ? "Reading the Brand Bible…" : avatars.length ? "Pick the avatar from the Brand Bible" : "No avatars in the Brand Bible yet"}
          </option>
          {(avatars ?? []).map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
              {a.tier ? ` (${a.tier})` : ""}
            </option>
          ))}
          <option value={OTHER}>Other (test a new avatar)</option>
        </select>
        <svg aria-hidden className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-faint" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {chosen?.who && <p className="line-clamp-2 text-[12px] leading-relaxed text-faint">{chosen.who}</p>}
      {testing && (
        <div className="grid gap-1.5 rounded-[12px] border border-warn/40 bg-warn-soft/40 p-3">
          <input
            value={value.avatar}
            onChange={(e) => onChange({ avatar: e.target.value.slice(0, 80), avatarTest: true })}
            placeholder="Name the new avatar, e.g. Weekend Warrior Dad"
            aria-label="New avatar to test"
            className="h-11 w-full rounded-[10px] border border-line bg-bg px-3 text-[16px] outline-none placeholder:text-faint focus:border-brand/60 md:text-[14px]"
          />
          <span className="text-[11.5px] text-warn">An avatar test: not in the Brand Bible yet. The ticket says so.</span>
        </div>
      )}
      {!testing && !hit && value.avatar.trim() && avatars && avatars.length > 0 && (
        <p className="text-[12px] text-warn">&ldquo;{value.avatar}&rdquo; isn&apos;t one of the Bible&apos;s avatars. Pick one, or Other to test it.</p>
      )}
    </div>
  );
}
