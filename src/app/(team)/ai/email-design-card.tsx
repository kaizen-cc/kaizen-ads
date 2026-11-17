"use client";

import { useEffect, useRef, useState } from "react";
import { PREVIEW_WIDTHS, previewScale, type PreviewWidth } from "@/lib/email-design/core";
import type { EmailDesignCard } from "@/lib/kaizen-ai/types";

// An email design from Kaizen AI's design studio: the email itself in a sandboxed frame (no scripts run in it) at
// desktop (600px) and phone (375px) widths, in light or dark mode, with its subject and preheader as the inbox shows
// them, the production checks, Copy HTML, Download, and the one import step to open it in Figma. Layout options of
// the same copy sit side by side as tabs.

const FRAME_HEIGHT: Record<PreviewWidth, number> = { desktop: 720, mobile: 740 };

function Segmented<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { value: T; label: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-full bg-ink/[0.05] p-0.5">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={value === it.value}
          onClick={() => onChange(it.value)}
          className={`min-h-10 rounded-full px-3.5 text-[12.5px] font-medium transition md:min-h-8 ${value === it.value ? "bg-surface text-fg shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted hover:text-fg"}`}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function ActionButton({ onClick, href, download, children }: { onClick?: () => void; href?: string; download?: boolean; children: React.ReactNode }) {
  const cls = "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-medium text-fg transition hover:border-brand/40 hover:bg-brand-soft/20 md:min-h-9";
  if (href)
    return (
      <a href={href} download={download || undefined} target={download ? undefined : "_blank"} rel="noopener noreferrer" className={cls}>
        {children}
      </a>
    );
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}

export function EmailDesignCardView({ c }: { c: EmailDesignCard }) {
  const [pick, setPick] = useState(0);
  const [device, setDevice] = useState<PreviewWidth>("desktop");
  const [dark, setDark] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showChecks, setShowChecks] = useState(false);
  const [showFigma, setShowFigma] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  const o = c.options[Math.min(pick, c.options.length - 1)];

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setRoom(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!o) return null;
  const src = `/api/ai/email-design/${o.id}?v=${o.version}`;
  const width = PREVIEW_WIDTHS[device];
  const scale = previewScale(room - 24, width);
  const height = FRAME_HEIGHT[device];
  const toFix = o.checks.filter((x) => !x.ok);

  const flash = (what: string) => {
    setCopied(what);
    setTimeout(() => setCopied(null), 1600);
  };
  const copyHtml = () => {
    // Safari only allows the clipboard inside the tap itself, so the text is handed over as a promise
    const text = fetch(`${src}&as=html`).then((r) => (r.ok ? r.text() : Promise.reject(new Error("not found"))));
    const done = typeof ClipboardItem !== "undefined" && navigator.clipboard?.write ? navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]) : text.then((t) => navigator.clipboard.writeText(t));
    void done.then(() => flash("html"), () => flash("failed"));
  };
  const copyLink = () => {
    if (o.shareUrl) void navigator.clipboard.writeText(o.shareUrl).then(() => flash("link"));
  };

  return (
    <section className="overflow-hidden rounded-[20px] border border-line bg-surface">
      <header className="grid gap-3 border-b border-line/70 px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">Email design{c.client ? ` · ${c.client}` : ""}</p>
            <p className="truncate text-[15px] font-semibold text-fg">{c.title}</p>
          </div>
          <span className="rounded-full bg-ink/[0.05] px-2.5 py-1 text-[11.5px] tabular-nums text-muted">Version {o.version}</span>
        </div>
        {c.options.length > 1 ? (
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
            {c.options.map((x, i) => (
              <button
                key={x.id}
                type="button"
                onClick={() => setPick(i)}
                aria-pressed={i === pick}
                className={`min-h-11 shrink-0 rounded-[14px] border px-3.5 text-left transition md:min-h-10 ${i === pick ? "border-brand/50 bg-brand-soft/30" : "border-line hover:border-brand/30"}`}
              >
                <span className="block text-[10.5px] uppercase tracking-[0.12em] text-faint">Option {String.fromCharCode(65 + i)}</span>
                <span className="block text-[13px] font-medium text-fg">{x.name || "Design"}</span>
              </button>
            ))}
          </div>
        ) : null}
      </header>

      {/* The inbox line: who it's from is the client, then the subject and the preheader */}
      <div className="grid gap-0.5 border-b border-line/70 bg-surface-2/50 px-4 py-2.5">
        <p className="truncate text-[13.5px] font-semibold text-fg">{o.subject || "No subject yet"}</p>
        <p className="truncate text-[12.5px] text-muted">{o.preheader || "No preheader yet"}</p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-3">
        <Segmented label="Preview width" value={device} onChange={setDevice} items={[{ value: "desktop", label: "Desktop" }, { value: "mobile", label: "Mobile" }]} />
        <Segmented label="Colour mode" value={dark ? "dark" : "light"} onChange={(v) => setDark(v === "dark")} items={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
      </div>

      <div ref={box} className="px-3 py-3">
        <div className="flex justify-center overflow-hidden rounded-[16px] bg-ink/[0.04] p-3" style={{ height: height * scale + 24 }}>
          <div className={`origin-top overflow-hidden shadow-[0_8px_30px_rgba(0,0,0,0.12)] ${device === "mobile" ? "rounded-[28px] ring-[6px] ring-ink/80" : "rounded-[6px]"}`} style={{ width, height, transform: `scale(${scale})`, flexShrink: 0 }}>
            <iframe key={`${src}-${dark}`} src={`${src}${dark ? "&dark=1" : ""}`} title={`${c.title}: ${device} preview`} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" loading="lazy" className="block border-0" style={{ width, height }} />
          </div>
        </div>
        <p className="px-1 pt-2 text-[11.5px] text-faint">
          {width}px wide{scale < 1 ? `, shown at ${Math.round(scale * 100)}%` : ""}. {dark ? "Dark mode shows the email's own dark styles (Apple Mail, Outlook); without them, the full colour flip some apps make." : "Scroll inside the frame to see it all."}
        </p>
      </div>

      {o.note ? <p className="px-4 pb-3 text-[13.5px] leading-relaxed text-fg/90">{o.note}</p> : null}

      <div className="flex flex-wrap gap-2 px-4 pb-3">
        <ActionButton onClick={copyHtml}>{copied === "html" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy HTML"}</ActionButton>
        <ActionButton href={`${src}&as=file`} download>
          Download .html
        </ActionButton>
        <ActionButton href={src}>Open full size</ActionButton>
        <ActionButton onClick={() => setShowFigma(!showFigma)}>Open in Figma</ActionButton>
      </div>

      {showFigma ? (
        <div className="mx-4 mb-3 grid gap-2 rounded-[14px] border border-line bg-surface-2/50 p-3.5 text-[13px] text-fg">
          <p className="font-semibold">One import step</p>
          <p className="text-muted">Figma doesn&rsquo;t let other apps draw into a file, so the design comes in through the html.to.design plugin as editable frames, text and pictures:</p>
          <ol className="grid list-decimal gap-1 pl-5 text-muted">
            <li>In Figma, open Plugins and run html.to.design.</li>
            <li>Paste the link below and import it at 600px (and again at 375px for the phone layout).</li>
          </ol>
          {o.shareUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-[10px] bg-ink/[0.05] px-2.5 py-2 text-[12px] text-muted">{o.shareUrl}</code>
              <ActionButton onClick={copyLink}>{copied === "link" ? "Copied" : "Copy link"}</ActionButton>
            </div>
          ) : (
            <p className="text-muted">A share link couldn&rsquo;t be made here: download the .html, open it in your browser and capture it with the html.to.design browser extension.</p>
          )}
          <p className="text-[12px] text-faint">
            The link works for 7 days and shows only this version. {c.figma ? "Figma is connected, so Kaizen AI reads the client's Figma styles and components before it designs." : "Connect Figma in Kaizen AI's connectors and it reads the client's Figma styles and components before it designs."}
          </p>
        </div>
      ) : null}

      <div className="border-t border-line/70">
        <button type="button" onClick={() => setShowChecks(!showChecks)} aria-expanded={showChecks} className="flex min-h-11 w-full items-center justify-between gap-2 px-4 text-[12.5px] text-muted hover:text-fg">
          <span className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${toFix.length ? "bg-warn" : "bg-ok"}`} aria-hidden />
            {toFix.length ? `Production checks: ${toFix.length} to fix` : "Production checks: all clear"}
          </span>
          <span aria-hidden>{showChecks ? "Hide" : "Show"}</span>
        </button>
        {showChecks ? (
          <ul className="grid gap-1 px-4 pb-3">
            {o.checks.map((x, i) => (
              <li key={i} className="flex items-start gap-2 text-[12.5px]">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${x.ok ? "bg-ok" : "bg-warn"}`} aria-hidden />
                <span className={x.ok ? "text-muted" : "text-fg"}>{x.text}</span>
              </li>
            ))}
            <li className="pt-1 text-[11.5px] text-faint">Pictures are on Kaizen links that last a year; upload them to the client&rsquo;s Klaviyo image library before it&rsquo;s scheduled.</li>
          </ul>
        ) : null}
      </div>
    </section>
  );
}
