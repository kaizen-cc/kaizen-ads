"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import type { SocialLinkView } from "@/lib/social/store";
import { saveSocialLink, socialPageChoices, syncSocialNow, type PageChoice } from "./social-actions";

// The client's Facebook Page and Instagram account for the Social tab: found by name, or picked here when the name
// matching missed or picked wrong. One dropdown, saved on change; a different Instagram account can be pasted by ID.

const btn = "inline-flex min-h-11 items-center rounded-full border border-line px-3.5 text-[12.5px] text-muted transition-colors hover:text-fg disabled:opacity-60 md:min-h-9";

export function SocialLink({ clientId, link, canEdit, openByDefault = false }: { clientId: string; link: SocialLinkView | null; canEdit: boolean; openByDefault?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(openByDefault);
  const [pages, setPages] = useState<PageChoice[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ig, setIg] = useState("");
  const [pending, start] = useTransition();

  const load = () =>
    start(async () => {
      const r = await socialPageChoices(clientId);
      if (!r.ok) return setMsg({ ok: false, text: r.error });
      setPages(r.pages);
      setNote(r.note);
    });
  const toggle = () => {
    setOpen((o) => !o);
    if (!pages && !pending) load();
  };
  // Opened on first view when there is no link yet: the choices load once
  useEffect(() => {
    if (openByDefault) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const save = (pageId: string, igId: string | null) =>
    start(async () => {
      setMsg(null);
      const r = await saveSocialLink(clientId, pageId, igId);
      setMsg(r.ok ? { ok: true, text: `Linked ${r.pageName ?? "the Page"}. Reading the last 90 days now.` } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const syncNow = () =>
    start(async () => {
      setMsg(null);
      const r = await syncSocialNow(clientId);
      setMsg(r.ok ? { ok: true, text: "Read just now." } : { ok: false, text: r.error });
      router.refresh();
    });

  return (
    <section className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="grid min-w-0 gap-1">
          <h3 className="font-heading text-[16px]">Accounts</h3>
          <p className="min-w-0 text-[13px] text-muted [overflow-wrap:anywhere]">
            {link?.pageId || link?.igId ? (
              <>
                {link.pageName ? `Facebook: ${link.pageName}` : link.pageId ? "Facebook Page linked" : "No Facebook Page"}
                {" · "}
                {link.igUsername ? `Instagram: @${link.igUsername}` : link.igId ? "Instagram account linked" : "No Instagram account on this Page"}
                <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10.5px] uppercase tracking-[0.08em] text-faint">{link.source === "manual" ? "Linked by hand" : "Found by name"}</span>
              </>
            ) : (
              "No Facebook Page or Instagram account linked yet."
            )}
          </p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-2">
            {(link?.pageId || link?.igId) && (
              <button type="button" onClick={syncNow} disabled={pending} className={btn}>
                {pending ? "Reading…" : "Sync now"}
              </button>
            )}
            <button type="button" onClick={toggle} aria-expanded={open} className={btn}>
              {link?.pageId || link?.igId ? "Change" : "Link accounts"}
            </button>
          </div>
        )}
      </div>

      {open && canEdit && (
        <div className="grid gap-3 rounded-[14px] border border-line bg-bg/40 p-3.5">
          <label className="grid gap-1.5 text-[12px] text-muted">
            Facebook Page
            <select
              value={link?.pageId ?? ""}
              disabled={pending || !pages}
              onChange={(e) => {
                const p = pages?.find((x) => x.id === e.target.value);
                if (p) save(p.id, p.igId);
              }}
              className="min-h-11 rounded-[12px] border border-line bg-surface px-3 text-[14px] text-fg"
            >
              <option value="" disabled>
                {pages ? "Choose their Page" : "Loading Pages…"}
              </option>
              {link?.pageId && !pages?.some((p) => p.id === link.pageId) && <option value={link.pageId}>{link.pageName ?? link.pageId}</option>}
              {pages?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.igUsername ? ` · @${p.igUsername}` : " · no Instagram"}
                </option>
              ))}
            </select>
          </label>
          {note && <p className="text-[12px] text-warn">{note}</p>}
          {pages && pages.length === 0 && !note && <p className="text-[12px] text-faint">The Meta system user has no Pages for this client. Assign their Page to it in Business Settings, or paste the Page&apos;s ID below.</p>}
          <details className="text-[12.5px] text-muted">
            <summary className="flex min-h-11 cursor-pointer items-center">Not listed, or a different Instagram account?</summary>
            <form
              className="grid gap-2 pb-1"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const pageId = String(f.get("page") ?? "").trim() || link?.pageId || "";
                if (!pageId) return setMsg({ ok: false, text: "Paste the Page's numeric ID." });
                save(pageId, ig.trim() || null);
              }}
            >
              <input name="page" inputMode="numeric" placeholder="Facebook Page ID (numbers)" className="min-h-11 rounded-[12px] border border-line bg-surface px-3 text-[14px] text-fg placeholder:text-faint" />
              <input value={ig} onChange={(e) => setIg(e.target.value)} inputMode="numeric" placeholder="Instagram account ID (optional; the Page's own is used if empty)" className="min-h-11 rounded-[12px] border border-line bg-surface px-3 text-[14px] text-fg placeholder:text-faint" />
              <button type="submit" disabled={pending} className={`${btn} justify-self-start`}>
                Save link
              </button>
            </form>
          </details>
        </div>
      )}
      {msg && <p className={`text-[12.5px] ${msg.ok ? "text-ok" : "text-bad"}`}>{msg.text}</p>}
    </section>
  );
}
