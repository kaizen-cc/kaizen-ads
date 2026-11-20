"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SocialLinkView } from "@/lib/social/store";
import type { LinkedAccount } from "@/lib/social/links-core";
import { addSocialAccountAction, findSocialAccounts, labelSocialAccountAction, removeSocialAccountAction, syncSocialNow, type PageChoice } from "./social-actions";

// The client's social accounts for the Social tab (Head of Social, Nov 19 2026): every Facebook Page and Instagram
// account, one per location where a client has several (Mama Betty's Parmer and Burnett), each labeled. The social
// team adds, removes and labels them here; "Find their Pages" links every Page that's clearly theirs among those
// Kaizen's Meta access can see, and lists the rest to pick from. A platform with nothing linked says so plainly.

const btn = "inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted transition-colors hover:text-fg disabled:opacity-60 md:min-h-9";
const field = "min-h-11 rounded-[12px] border border-line bg-surface px-3 text-[14px] text-fg placeholder:text-faint outline-none focus:border-brand/60 md:min-h-9 md:text-[13px]";

function Glyph({ platform }: { platform: "facebook" | "instagram" }) {
  return (
    <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[11px] font-semibold ${platform === "instagram" ? "bg-[#e1306c]/15 text-[#e1306c]" : "bg-[#1877f2]/15 text-[#1877f2]"}`}>
      {platform === "instagram" ? "IG" : "FB"}
    </span>
  );
}

function AccountRow({ a, canEdit, onLabel, onRemove, pending }: { a: LinkedAccount; canEdit: boolean; onLabel: (v: string) => void; onRemove: () => void; pending: boolean }) {
  const [loc, setLoc] = useState(a.location ?? "");
  const name = a.platform === "instagram" && a.name ? `@${a.name.replace(/^@/, "")}` : (a.name ?? a.accountId);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-line bg-bg/40 px-3 py-2.5">
      <Glyph platform={a.platform} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-[13.5px] text-fg">{name}</span>
        <span className="text-[11px] text-faint">{a.source === "primary" ? "Main account" : a.source === "auto" ? "Found by name" : "Added by hand"}</span>
      </span>
      {canEdit ? (
        <input
          value={loc}
          onChange={(e) => setLoc(e.target.value)}
          onBlur={() => loc.trim() !== (a.location ?? "") && onLabel(loc)}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          placeholder="Location"
          aria-label={`Location of ${name}`}
          className={`${field} w-full sm:w-40`}
        />
      ) : (
        a.location && <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11.5px] text-muted">{a.location}</span>
      )}
      {canEdit && (
        <button type="button" disabled={pending} onClick={onRemove} className="min-h-11 px-1 text-[12px] text-faint hover:text-bad md:min-h-0">
          Remove
        </button>
      )}
    </li>
  );
}

export function SocialLink({ clientId, link, canEdit, openByDefault = false }: { clientId: string; link: SocialLinkView | null; canEdit: boolean; openByDefault?: boolean }) {
  const router = useRouter();
  const accounts = link?.accounts ?? [];
  const fb = accounts.filter((a) => a.platform === "facebook");
  const ig = accounts.filter((a) => a.platform === "instagram");
  const [open, setOpen] = useState(openByDefault);
  const [pages, setPages] = useState<PageChoice[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [location, setLocation] = useState("");
  const [paste, setPaste] = useState({ page: "", ig: "" });
  const [pending, start] = useTransition();

  // Finding links what's clearly theirs at once and lists the rest to pick from
  const find = () =>
    start(async () => {
      setMsg(null);
      const r = await findSocialAccounts(clientId);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setPages(r.pages);
      setNote(r.note);
      setMsg(r.added.length ? { ok: true, text: `Linked ${r.added.join(", ")}. Reading them now.` } : { ok: true, text: "Nothing new is clearly theirs among the Pages Kaizen can see: pick one below, or ask the client to share it." });
      router.refresh();
    });
  useEffect(() => {
    if (openByDefault && canEdit) find();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const add = (input: { pageId?: string | null; igId?: string | null }) =>
    start(async () => {
      setMsg(null);
      const r = await addSocialAccountAction(clientId, { ...input, location: location.trim() || null });
      setMsg(r.ok ? { ok: true, text: `Linked ${r.added.join(" and ")}. Reading the last 90 days now.` } : { ok: false, text: r.error });
      if (r.ok) {
        setLocation("");
        setPaste({ page: "", ig: "" });
        setPages((ps) => ps?.filter((p) => p.id !== input.pageId) ?? ps);
        router.refresh();
      }
    });
  const act = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done?: string) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(r.ok ? (done ? { ok: true, text: done } : null) : { ok: false, text: r.error });
      router.refresh();
    });
  const syncNow = () =>
    start(async () => {
      setMsg(null);
      const r = await syncSocialNow(clientId);
      setMsg(r.ok ? { ok: true, text: "Read just now." } : { ok: false, text: r.error });
      router.refresh();
    });

  const group = (title: string, platform: "facebook" | "instagram", list: LinkedAccount[]) => (
    <div className="grid gap-2">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{title}</p>
      {list.length ? (
        <ul className="grid gap-2">
          {list.map((a) => (
            <AccountRow key={a.id} a={a} canEdit={canEdit} pending={pending} onLabel={(v) => act(() => labelSocialAccountAction(clientId, a.id, v))} onRemove={() => act(() => removeSocialAccountAction(clientId, a.id), "Taken off. Its numbers are kept, and it won't be linked again by name.")} />
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-3 rounded-[14px] border border-dashed border-line px-3 py-2.5 text-[13px] text-muted">
          <Glyph platform={platform} />
          Not linked
        </p>
      )}
    </div>
  );

  return (
    <section className="grid gap-4 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-1">
          <h3 className="font-heading text-[16px]">Accounts</h3>
          <p className="text-[12.5px] text-muted">{accounts.length ? `${fb.length} Facebook ${fb.length === 1 ? "Page" : "Pages"} · ${ig.length} Instagram ${ig.length === 1 ? "account" : "accounts"}. Each location is read and scored, and rolled up for the client.` : "Nothing linked yet."}</p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            {accounts.length > 0 && (
              <button type="button" onClick={syncNow} disabled={pending} className={btn}>
                {pending ? "Working…" : "Sync now"}
              </button>
            )}
            <button type="button" onClick={find} disabled={pending} className={btn}>
              Find their Pages
            </button>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={btn}>
              Add an account
            </button>
          </div>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {group("Facebook Pages", "facebook", fb)}
        {group("Instagram accounts", "instagram", ig)}
      </div>

      {open && canEdit && (
        <div className="grid gap-3 rounded-[14px] border border-line bg-bg/40 p-3.5" style={{ animation: "card-in .2s cubic-bezier(.2,.8,.2,1) both" }}>
          <label className="grid gap-1.5 text-[12px] text-muted">
            Location (for the account you add next)
            <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Parmer, Burnett, Downtown" className={field} />
          </label>
          {pages === null ? (
            <button type="button" onClick={find} disabled={pending} className={`${btn} justify-self-start`}>
              {pending ? "Looking…" : "Show the Pages Kaizen can see"}
            </button>
          ) : pages.length ? (
            <div className="grid gap-1.5">
              <p className="text-[12px] text-muted">Pages Kaizen can see that aren&apos;t linked:</p>
              <ul className="grid max-h-72 gap-1 overflow-y-auto overscroll-contain rounded-[12px] border border-line p-1">
                {pages.map((p) => (
                  <li key={p.id}>
                    <button type="button" disabled={pending} onClick={() => add({ pageId: p.id })} className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[10px] px-2.5 py-2 text-left hover:bg-ink/[0.05] disabled:opacity-60">
                      <span className="grid min-w-0 gap-0.5">
                        <span className="truncate text-[13px] text-fg">{p.name}</span>
                        <span className="text-[11px] text-faint">{p.igUsername ? `Instagram @${p.igUsername} comes with it` : "No Instagram on this Page"}</span>
                      </span>
                      <span className="text-[12px] text-brand-text">Link</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-[12px] text-faint">Kaizen&apos;s Meta access sees no other Pages. Ask the client to share the Page with Kaizen&apos;s Business Manager, then look again, or paste its ID below.</p>
          )}
          {note && <p className="text-[12px] text-warn">{note}</p>}
          <form
            className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (!paste.page.trim() && !paste.ig.trim()) return setMsg({ ok: false, text: "Paste a Page ID or an Instagram account ID." });
              add({ pageId: paste.page.trim() || null, igId: paste.ig.trim() || null });
            }}
          >
            <input value={paste.page} onChange={(e) => setPaste((x) => ({ ...x, page: e.target.value }))} inputMode="numeric" placeholder="Facebook Page ID" className={field} />
            <input value={paste.ig} onChange={(e) => setPaste((x) => ({ ...x, ig: e.target.value }))} inputMode="numeric" placeholder="Instagram account ID (optional)" className={field} />
            <button type="submit" disabled={pending} className={btn}>
              Add
            </button>
          </form>
        </div>
      )}
      {msg && <p className={`text-[12.5px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
    </section>
  );
}
