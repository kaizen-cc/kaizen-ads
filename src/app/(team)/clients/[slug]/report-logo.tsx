"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { contrast, paletteFor } from "@/lib/reports/brand";
import { findReportLogo, resetReportLogo, setReportColor, uploadReportLogo } from "./report-logo-actions";

// The client's look on their weekly report: the logo beside Kaizen's in the header (only theirs for a white label
// client) and the brand colour on its band, tiles and charts. Found on its own (Brand Bible, website, Drive); upload one
// when none is found or the one found isn't right, and set the colour by hand when the logo's isn't the brand's.

const SOURCE: Record<string, string> = { upload: "Uploaded here", website: "From their website", "website share image": "From their website", Drive: "From their Drive folder", "Brand Bible": "From the Brand Bible" };
const COLOR_SOURCE: Record<string, string> = { set: "set here", "Brand Bible": "from the Brand Bible", logo: "from the logo" };

export function ReportLogo(props: { clientId: string; slug: string; name: string; whiteLabel: boolean; logo: string | null; light: boolean; color: string | null; source: string | null; colorSource: string | null; uploaded: boolean; checked: boolean }) {
  const router = useRouter();
  const file = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [hex, setHex] = useState(props.color ?? "");
  const pal = paletteFor(props.color, { whiteLabel: props.whiteLabel });
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string) =>
    start(async () => {
      const r = await fn();
      setNote(r.ok ? { ok: true, text: done } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  const validHex = /^#?[0-9a-f]{6}$/i.test(hex.trim());
  return (
    <div className="grid gap-4">
      {/* What the report's header looks like with it */}
      <div className="overflow-hidden rounded-[14px] border border-line">
        <div className="flex items-center gap-3 bg-white px-4 py-3">
          {props.logo ? (
            <span className="rounded-[8px] px-2 py-1" style={{ background: props.light ? pal.hero : "transparent" }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a small data URI preview */}
              <img src={props.logo} alt={`${props.name} logo`} className="h-8 max-w-[160px] object-contain" />
            </span>
          ) : (
            <span className="text-[15px] font-semibold" style={{ color: pal.accentText }}>
              {props.name}
            </span>
          )}
          {!props.whiteLabel && (
            <>
              <span className="h-6 w-px bg-[#cbd6df]" />
              {/* eslint-disable-next-line @next/next/no-img-element -- the agency's own logo */}
              <img src="/kaizen-logo.png" alt="Kaizen" className="h-5 w-auto" />
            </>
          )}
        </div>
        <div className="px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.14em]" style={{ background: `linear-gradient(120deg, ${pal.hero}, ${pal.heroEdge})`, color: pal.heroSoft }}>
          Weekly report
        </div>
      </div>
      <p className="text-[13px] text-muted">
        {props.logo ? (SOURCE[props.source ?? ""] ?? "Found automatically") : props.checked ? "No logo found on their website, Brand Bible or Drive: the report shows their name. Upload one below." : "Looked for the first time their report is drawn."}
        {props.color ? ` Colour ${props.color.toUpperCase()}${props.colorSource ? `, ${COLOR_SOURCE[props.colorSource] ?? props.colorSource}` : ""}.` : " No brand colour found: the report uses its own navy."}
        {props.whiteLabel ? " White label: Kaizen's logo and name never appear." : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const form = new FormData();
            form.set("logo", f);
            run(() => uploadReportLogo(props.clientId, props.slug, form), "Logo saved: their next report carries it.");
            e.target.value = "";
          }}
        />
        <button type="button" disabled={pending} onClick={() => file.current?.click()} className="h-11 rounded-full bg-fg px-4 text-[13px] font-medium text-bg disabled:opacity-50 md:h-9">
          {pending ? "Saving…" : props.uploaded ? "Upload another logo" : "Upload report logo"}
        </button>
        {props.uploaded ? (
          <button type="button" disabled={pending} onClick={() => run(() => resetReportLogo(props.clientId, props.slug), "Back to the logo found automatically.")} className="h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:h-9">
            Use the one found instead
          </button>
        ) : (
          <button type="button" disabled={pending} onClick={() => run(() => findReportLogo(props.clientId, props.slug), "Looked again.")} className="h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:h-9">
            Look again
          </button>
        )}
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!validHex) return;
          const v = `#${hex.trim().replace(/^#/, "")}`;
          // A colour too pale for white text or bars is still taken: the report deepens it until it reads
          run(() => setReportColor(props.clientId, props.slug, v), contrast(v, "#ffffff") < 3 ? "Colour saved. It's light, so the report deepens it where text sits on it." : "Colour saved.");
        }}
      >
        <label className="flex items-center gap-2 text-[13px] text-muted">
          <span className="h-6 w-6 rounded-full border border-line" style={{ background: validHex ? `#${hex.trim().replace(/^#/, "")}` : "transparent" }} />
          <input value={hex} onChange={(e) => setHex(e.target.value)} placeholder="#1F4E79" maxLength={7} className="h-11 w-28 rounded-[10px] border border-line bg-bg px-3 font-mono text-[13px] text-fg outline-none focus:border-brand-text/60 md:h-9" aria-label="Report colour (hex)" />
        </label>
        <button type="submit" disabled={pending || !validHex} className="h-11 rounded-full border border-line px-3 text-[13px] text-muted hover:text-fg disabled:opacity-40 md:h-9">
          Set colour
        </button>
        {props.colorSource === "set" && (
          <button type="button" disabled={pending} onClick={() => run(() => setReportColor(props.clientId, props.slug, ""), "Back to the colour found automatically.")} className="h-11 rounded-full px-3 text-[13px] text-muted hover:text-fg disabled:opacity-50 md:h-9">
            Use the one found
          </button>
        )}
      </form>
      {note && <p className={`text-[12.5px] ${note.ok ? "text-ok" : "text-bad"}`}>{note.text}</p>}
    </div>
  );
}
