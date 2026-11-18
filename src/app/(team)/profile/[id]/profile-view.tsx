"use client";

import { useRef, useState, useTransition } from "react";
import { PersonAvatar } from "@/components/person-avatar";
import { field } from "@/components/ui";
import { startLabel, tenureOf, type SlackField } from "@/lib/profile";
import { importFromSlack, removeAvatar, saveProfile, uploadAvatar } from "../actions";

export type ProfilePerson = {
  id: string;
  fullName: string;
  email: string;
  role: string;
  active: boolean;
  avatarUrl: string | null;
  displayName: string | null;
  title: string | null;
  bio: string | null;
  startDate: string | null;
};

const label = "text-[11px] uppercase tracking-[0.16em] text-faint";
const ghost = "inline-flex min-h-11 items-center justify-center rounded-full border border-line px-4 text-[13px] text-muted transition-colors hover:border-faint hover:text-fg disabled:opacity-50 md:min-h-9";

/** The browser crops a picture to a centered square and sizes it down to 512 px (a JPEG), so uploads stay small */
async function squared(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const out = Math.min(512, side);
  const canvas = document.createElement("canvas");
  canvas.width = out;
  canvas.height = out;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, out, out);
  bitmap.close();
  return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("no image"))), "image/jpeg", 0.9));
}

function SlackButton({ field: f, mine, slack, onDone, onError, busy }: { field: SlackField; mine: boolean; slack: boolean; onDone: (v: string) => void; onError: (e: string) => void; busy: boolean }) {
  const [pending, start] = useTransition();
  if (!mine || !slack) return null;
  return (
    <button
      type="button"
      disabled={pending || busy}
      onClick={() =>
        start(async () => {
          const r = await importFromSlack(f);
          if (r.ok) onDone(r.value);
          else onError(r.error);
        })
      }
      className="min-h-11 rounded-full px-2 text-[12px] text-faint transition-colors hover:text-fg disabled:opacity-50 md:min-h-8"
    >
      {pending ? "Importing…" : "Import from Slack"}
    </button>
  );
}

export function ProfileView({ person, mine, slack }: { person: ProfilePerson; mine: boolean; slack: boolean }) {
  const [displayName, setDisplayName] = useState(person.displayName ?? "");
  const [title, setTitle] = useState(person.title ?? "");
  const [bio, setBio] = useState(person.bio ?? "");
  const [start, setStart] = useState(person.startDate ?? "");
  const [avatar, setAvatar] = useState(person.avatarUrl);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, run] = useTransition();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const shown = displayName.trim() || person.fullName;
  const tenure = tenureOf(start || null);

  const ok = (text = "Saved") => setNote({ ok: true, text });
  const bad = (text: string) => setNote({ ok: false, text });
  const save = (patch: Parameters<typeof saveProfile>[0]) =>
    run(async () => {
      setNote(null);
      const r = await saveProfile(patch);
      if (r.ok) ok();
      else bad(r.error);
    });

  const choose = (file: File | undefined) => {
    if (!file) return;
    run(async () => {
      setNote(null);
      try {
        const blob = await squared(file);
        const form = new FormData();
        form.set("file", new File([blob], "avatar.jpg", { type: "image/jpeg" }));
        const r = await uploadAvatar(form);
        if (r.ok) {
          setAvatar(r.url);
          ok("Picture saved");
        } else bad(r.error);
      } catch {
        bad("Couldn't read that picture. Try a JPG or PNG.");
      }
    });
  };

  // What others see: a read-only card
  if (!mine) {
    return (
      <article className="relative overflow-hidden rounded-[24px] border border-line bg-surface p-6 sm:p-8">
        <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-60 w-60 rounded-full bg-brand/15 blur-3xl" />
        <div className="relative flex flex-col items-center gap-4 text-center sm:flex-row sm:items-center sm:text-left">
          <PersonAvatar name={person.fullName} size={104} src={avatar} muted={!person.active} />
          <div className="grid min-w-0 gap-1">
            <h1 className="font-heading text-[28px] leading-tight [overflow-wrap:anywhere]">{shown}</h1>
            <p className="text-[14px] text-muted [overflow-wrap:anywhere]">{[person.title, person.role].filter(Boolean).join(" · ")}</p>
            <p className="text-[13px] text-faint [overflow-wrap:anywhere]">{person.email}</p>
          </div>
        </div>
        <dl className="relative mt-6 grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1">
            <dt className={label}>With Kaizen</dt>
            <dd className="text-[15px]">{tenure ? `${tenure}${startLabel(start) ? `, since ${startLabel(start)}` : ""}` : "Not shared yet"}</dd>
          </div>
        </dl>
        {bio.trim() && (
          <div className="relative mt-5 grid gap-1">
            <p className={label}>About</p>
            <p className="whitespace-pre-line text-[14.5px] leading-relaxed text-muted">{bio}</p>
          </div>
        )}
      </article>
    );
  }

  return (
    <article className="relative grid gap-6 overflow-hidden rounded-[24px] border border-line bg-surface p-5 sm:p-7">
      <span aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-60 w-60 rounded-full bg-brand/15 blur-3xl" />
      <div className="relative flex flex-col items-center gap-4 text-center sm:flex-row sm:text-left">
        <PersonAvatar name={person.fullName} size={104} src={avatar} />
        <div className="grid min-w-0 flex-1 gap-1">
          <h1 className="font-heading text-[26px] leading-tight [overflow-wrap:anywhere]">{shown}</h1>
          <p className="text-[13.5px] text-muted [overflow-wrap:anywhere]">{[title.trim() || null, person.role].filter(Boolean).join(" · ")}</p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-2 sm:justify-start">
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => (choose(e.target.files?.[0]), (e.target.value = ""))} />
            <button type="button" disabled={pending} onClick={() => fileRef.current?.click()} className={ghost}>
              {avatar ? "Change picture" : "Add a picture"}
            </button>
            {avatar && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const r = await removeAvatar();
                    if (r.ok) {
                      setAvatar(null);
                      ok("Picture removed");
                    } else bad(r.error);
                  })
                }
                className="min-h-11 rounded-full px-2 text-[12px] text-faint transition-colors hover:text-bad md:min-h-8"
              >
                Remove
              </button>
            )}
            <SlackButton
              field="avatar_url"
              mine
              slack={slack}
              busy={pending}
              onDone={(v) => {
                setAvatar(v);
                ok("Picture imported from Slack");
              }}
              onError={bad}
            />
          </div>
        </div>
      </div>

      <div className="relative grid gap-5">
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="p-name" className={label}>
              Name you go by
            </label>
            <SlackButton field="display_name" mine slack={slack} busy={pending} onDone={(v) => (setDisplayName(v), ok("Name imported from Slack"))} onError={bad} />
          </div>
          <input
            id="p-name"
            value={displayName}
            maxLength={60}
            placeholder={person.fullName}
            onChange={(e) => setDisplayName(e.target.value)}
            onBlur={() => displayName.trim() !== (person.displayName ?? "") && save({ display_name: displayName })}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())}
            className={`${field} h-12 text-[16px] md:text-[14px]`}
          />
        </div>

        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="p-title" className={label}>
              Title
            </label>
            <SlackButton field="title" mine slack={slack} busy={pending} onDone={(v) => (setTitle(v), ok("Title imported from Slack"))} onError={bad} />
          </div>
          <input
            id="p-title"
            value={title}
            maxLength={80}
            placeholder="What you do at Kaizen"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title.trim() !== (person.title ?? "") && save({ title })}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())}
            className={`${field} h-12 text-[16px] md:text-[14px]`}
          />
        </div>

        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="p-bio" className={label}>
              About you
            </label>
            <SlackButton field="bio" mine slack={slack} busy={pending} onDone={(v) => (setBio(v), ok("Bio imported from Slack"))} onError={bad} />
          </div>
          <textarea
            id="p-bio"
            value={bio}
            maxLength={500}
            rows={4}
            placeholder="A few lines your team should know: what you love working on, where you're based, how to work with you"
            onChange={(e) => setBio(e.target.value)}
            onBlur={() => bio.trim() !== (person.bio ?? "") && save({ bio })}
            className={`${field} min-h-28 resize-y py-3 text-[16px] leading-relaxed md:text-[14px]`}
          />
          <p className="text-right text-[11px] text-faint">{bio.length} / 500</p>
        </div>

        <div className="grid gap-1.5">
          <label htmlFor="p-start" className={label}>
            Started at Kaizen
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <input
              id="p-start"
              type="date"
              value={start}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => {
                setStart(e.target.value);
                save({ start_date: e.target.value || null });
              }}
              className={`${field} h-12 w-full text-[16px] sm:w-56 md:text-[14px]`}
            />
            {tenure && <span className="rounded-full bg-surface-2 px-3 py-1.5 text-[13px] text-muted">{tenure}</span>}
          </div>
        </div>
      </div>

      <p aria-live="polite" className="relative min-h-[1.2em] text-[12.5px]">
        {note ? <span className={note.ok ? "text-muted" : "text-bad"}>{note.text}</span> : null}
      </p>
      <p className="relative -mt-3 text-[12px] leading-relaxed text-faint">
        This started from your Slack profile. Changes here stay in Kaizen OS: they never change Slack, and Slack never changes them unless you press Import from Slack.
      </p>
    </article>
  );
}
