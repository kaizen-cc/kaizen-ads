"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SocialLinkView } from "@/lib/social/store";
import { accountStatus, locationGroups, type LinkedAccount } from "@/lib/social/links-core";
import { addSocialAccountAction, businessManagerSocialPages, findSocialAccounts, labelSocialAccountAction, removeSocialAccountAction, socialBusinessManagers, syncSocialNow, type SocialBm, type SocialBmPage } from "./social-actions";

// The client's social connections (Team & setup, and the Social tab): every Facebook Page and Instagram account, one
// per location where a client has several (Mama Betty's Parmer and Burnett), shown by location with a location's Page
// and Instagram paired (they share its label), each with its state: linked and reading, waiting for its first read, or
// what access it needs, and the Business Manager it came through. Executives, leads and the line heads add, remove and
// label them. Adding starts from a Business Manager (owner, Nov 20 2026), the same list as the client's Meta ad account,
// on the one their ads go through: only that Business Manager's Pages (and the Instagram on each) are offered, the ones
// that look like the client first. A Business Manager that sees none of theirs says so: we need partner access. A
// platform with nothing linked says "Not linked" plainly.

const btn = "inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted transition-colors hover:text-fg disabled:opacity-60 md:min-h-9";
const field = "min-h-11 rounded-[12px] border border-line bg-surface px-3 text-[14px] text-fg placeholder:text-faint outline-none focus:border-brand/60 md:min-h-9 md:text-[13px]";

function Glyph({ platform }: { platform: "facebook" | "instagram" }) {
  return (
    <span aria-hidden className={`grid h-8 w-8 shrink-0 place-items-center rounded-[10px] text-[11px] font-semibold ${platform === "instagram" ? "bg-[#e1306c]/15 text-[#e1306c]" : "bg-[#1877f2]/15 text-[#1877f2]"}`}>
      {platform === "instagram" ? "IG" : "FB"}
    </span>
  );
}

const STATE_TONE = { reading: "bg-ok", pending: "bg-faint", access: "bg-bad" } as const;

function AccountRow({ a, canEdit, onLabel, onRemove, pending, listId }: { a: LinkedAccount; canEdit: boolean; onLabel: (v: string) => void; onRemove: () => void; pending: boolean; listId: string }) {
  const [loc, setLoc] = useState(a.location ?? "");
  const name = a.platform === "instagram" && a.name ? `@${a.name.replace(/^@/, "")}` : (a.name ?? a.accountId);
  const st = accountStatus(a);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[14px] border border-line bg-bg/40 px-3 py-2.5">
      <Glyph platform={a.platform} />
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span className="truncate text-[13.5px] text-fg">{name}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-faint" title={st.text}>
          <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATE_TONE[st.state]}`} />
          <span className={`truncate ${st.state === "access" ? "text-bad" : ""}`}>{st.state === "access" ? `Needs access: ${st.text}` : st.text}</span>
          <span className="shrink-0">· {a.businessName ? `via ${a.businessName}` : a.source === "primary" ? "main" : a.source === "auto" ? "found by name" : "added by hand"}</span>
        </span>
      </span>
      {canEdit ? (
        <input
          value={loc}
          onChange={(e) => setLoc(e.target.value)}
          onBlur={() => loc.trim() !== (a.location ?? "") && onLabel(loc)}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
          placeholder="Location"
          list={listId}
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
  const [bms, setBms] = useState<SocialBm[] | null>(null);
  const [bm, setBm] = useState<string | null>(null);
  const [pages, setPages] = useState<SocialBmPage[] | null>(null);
  const [bmName, setBmName] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [location, setLocation] = useState("");
  const [paste, setPaste] = useState({ page: "", ig: "" });
  const [pending, start] = useTransition();

  // A Business Manager's Pages (the ones that look like the client first)
  const loadPages = (id: string) =>
    start(async () => {
      setPages(null);
      setNote(null);
      const r = await businessManagerSocialPages(clientId, id);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setPages(r.pages);
      setBmName(r.bm);
      setNote(r.note);
    });
  // Opening the panel: the Business Managers, starting on the one the client's Meta ads go through
  const loadBms = () =>
    start(async () => {
      const r = await socialBusinessManagers(clientId);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setBms(r.options);
      setBm(r.selected);
      if (r.selected) loadPages(r.selected);
    });
  const openPanel = () => {
    setOpen(true);
    if (!bms) loadBms();
  };
  const pickBm = (id: string) => {
    setBm(id);
    loadPages(id);
  };
  // Every Page in the picked Business Manager that's clearly theirs, linked at once
  const find = () =>
    start(async () => {
      setMsg(null);
      const r = await findSocialAccounts(clientId, bm);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setMsg(r.added.length ? { ok: true, text: `Linked ${r.added.join(", ")}. Reading them now.` } : { ok: true, text: `Nothing new in ${bmName ?? "that Business Manager"} is clearly theirs: pick a Page below.` });
      if (bm) loadPages(bm);
      router.refresh();
    });
  useEffect(() => {
    if (openByDefault && canEdit) loadBms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const add = (input: { pageId?: string | null; igId?: string | null }) =>
    start(async () => {
      setMsg(null);
      const r = await addSocialAccountAction(clientId, { ...input, location: location.trim() || null, ...(bm ? { bmId: bm } : {}) });
      setMsg(r.ok ? { ok: true, text: `Linked ${r.added.join(" and ")}. Reading the last 90 days now.` } : { ok: false, text: r.error });
      if (r.ok) {
        setLocation("");
        setPaste({ page: "", ig: "" });
        setPages((ps) => ps?.map((p) => (p.id === input.pageId ? { ...p, linked: true } : p)) ?? ps);
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

  const listId = `social-locations-${clientId}`;
  const labels = [...new Set(accounts.map((a) => a.location?.trim()).filter((x): x is string => Boolean(x)))];
  const groups = locationGroups(accounts);
  const row = (a: LinkedAccount) => (
    <AccountRow key={a.id} a={a} canEdit={canEdit} pending={pending} listId={listId} onLabel={(v) => act(() => labelSocialAccountAction(clientId, a.id, v))} onRemove={() => act(() => removeSocialAccountAction(clientId, a.id), "Taken off. Its numbers are kept, and it won't be linked again by name.")} />
  );
  const notLinked = (platform: "facebook" | "instagram") => (
    <p className="flex items-center gap-3 rounded-[14px] border border-dashed border-line px-3 py-2.5 text-[13px] text-muted">
      <Glyph platform={platform} />
      {platform === "facebook" ? "Facebook" : "Instagram"}: Not linked
    </p>
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
            <button type="button" onClick={() => (open ? setOpen(false) : openPanel())} aria-expanded={open} className={btn}>
              {open ? "Done" : "Add from a Business Manager"}
            </button>
          </div>
        )}
      </div>

      <datalist id={listId}>
        {labels.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      {(!fb.length || !ig.length) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {!fb.length && notLinked("facebook")}
          {!ig.length && notLinked("instagram")}
        </div>
      )}
      {groups.length > 0 && (
        <div className="grid gap-3">
          {groups.map((g) => (
            <div key={g.key} className="grid gap-2">
              {groups.length > 1 && <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{g.label}</p>}
              <ul className="grid gap-2 md:grid-cols-2">{g.accounts.map(row)}</ul>
            </div>
          ))}
          {groups.length > 1 && <p className="text-[11.5px] text-faint">{groups.length} locations. Reports show the whole company, then each location.</p>}
        </div>
      )}

      {open && canEdit && (
        <div className="grid min-w-0 gap-3.5 rounded-[16px] border border-line bg-bg/40 p-3.5 md:p-4" style={{ animation: "card-in .2s cubic-bezier(.2,.8,.2,1) both" }}>
          <div className="grid min-w-0 gap-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Business Manager</p>
            {bms ? (
              <div role="radiogroup" aria-label="Business Manager" className="no-scrollbar -mx-1 flex snap-x gap-1.5 overflow-x-auto px-1 pb-0.5">
                {bms.map((o) => {
                  const on = o.id === bm;
                  const off = !o.isDefault && o.status !== "active";
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      disabled={off || pending}
                      onClick={() => pickBm(o.id)}
                      className={`inline-flex min-h-11 shrink-0 snap-start items-center gap-2 rounded-full border px-3.5 text-[12.5px] transition-colors disabled:opacity-50 md:min-h-9 ${on ? "border-brand/50 bg-brand/10 font-medium text-fg" : "border-line text-muted hover:border-faint hover:text-fg"}`}
                    >
                      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${o.status === "active" || o.isDefault ? "bg-ok" : "bg-faint"}`} />
                      {o.name}
                      {o.isDefault && <span className="text-faint">· Kaizen&apos;s</span>}
                      {off && <span className="text-faint">· not connected</span>}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="h-11 animate-pulse rounded-full bg-surface-2 md:h-9" aria-label="Loading the Business Managers" />
            )}
            <p className="text-[11.5px] text-faint">The same Business Managers as their Meta ad account, starting on the one their ads go through. Only its Pages are listed.</p>
          </div>
          <label className="grid gap-1.5 text-[12px] text-muted">
            Location (the same location pairs a Page and an Instagram)
            <input value={location} onChange={(e) => setLocation(e.target.value)} list={listId} placeholder="e.g. Parmer, Burnett, Downtown" className={field} />
          </label>
          {bm && pages === null && (
            <div className="grid gap-1.5" aria-label="Loading the Pages">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-14 animate-pulse rounded-[12px] bg-surface-2" />
              ))}
            </div>
          )}
          {pages && pages.length > 0 && (
            <div className="grid min-w-0 gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[12px] text-muted">
                  {bmName}&apos;s Pages · {pages.length}
                </p>
                {pages.some((p) => p.likely && !p.linked) && (
                  <button type="button" onClick={find} disabled={pending} className={btn}>
                    Link the ones that look like theirs
                  </button>
                )}
              </div>
              <ul className="grid max-h-80 gap-1 overflow-y-auto overscroll-contain rounded-[14px] border border-line p-1">
                {pages.map((p) => (
                  <li key={p.id}>
                    <button type="button" disabled={pending || p.linked} onClick={() => add({ pageId: p.id })} className="grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-[11px] px-2.5 py-2 text-left transition-colors hover:bg-ink/[0.05] disabled:hover:bg-transparent">
                      <Glyph platform="facebook" />
                      <span className="grid min-w-0 gap-0.5">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[13.5px] text-fg">{p.name}</span>
                          {p.likely && !p.linked && <span className="shrink-0 rounded-full bg-brand/10 px-1.5 py-px text-[10px] text-brand-text">Looks like theirs</span>}
                        </span>
                        <span className="truncate text-[11px] text-faint">
                          {p.igUsername ? `Instagram @${p.igUsername} comes with it` : "No Instagram on this Page"} · {p.how === "owned" ? "owned" : p.how === "client" ? "shared by the client" : "assigned"}
                        </span>
                      </span>
                      <span className={`text-[12px] ${p.linked ? "text-ok" : "text-brand-text"}`}>{p.linked ? "Linked" : "Link"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {note && <p className="rounded-[12px] border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] leading-relaxed text-fg/90">{note}</p>}
          <details className="text-[12.5px] text-muted">
            <summary className="flex min-h-11 cursor-pointer items-center md:min-h-9">Have its ID instead?</summary>
            <form
              className="grid gap-2 pt-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
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
          </details>
        </div>
      )}
      {msg && <p className={`text-[12.5px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
    </section>
  );
}
