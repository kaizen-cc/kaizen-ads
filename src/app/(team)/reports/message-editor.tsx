"use client";

import { useRef, useState } from "react";

// The report's message, edited with formatting buttons instead of typed symbols: bold, italic, underline, strikethrough,
// a link and emoji. It's kept as Slack's own formatting (*bold*, _italic_, ~strike~, <url|words>), so Slack shows it as
// written and the email draws the same marks; underline (++words++) is the email's alone: Slack posts the plain words.

const EMOJI = ["🎉", "🚀", "📈", "📉", "✅", "⚠️", "🔥", "💡", "👏", "🙌", "👀", "💰", "🛒", "📩", "📱", "⭐", "❤️", "🙏", "😊", "👉", "📅", "🎯", "🏆", "✨"];

type Mark = { key: string; label: string; title: string; open: string; close: string; className: string };
const MARKS: Mark[] = [
  { key: "b", label: "B", title: "Bold (Ctrl+B)", open: "*", close: "*", className: "font-bold" },
  { key: "i", label: "I", title: "Italic (Ctrl+I)", open: "_", close: "_", className: "italic" },
  { key: "u", label: "U", title: "Underline (Ctrl+U): shows in the email; Slack posts the plain words", open: "++", close: "++", className: "underline" },
  { key: "s", label: "S", title: "Strikethrough", open: "~", close: "~", className: "line-through" },
];

export function MessageEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const [panel, setPanel] = useState<"link" | "emoji" | null>(null);
  const [url, setUrl] = useState("");
  const [words, setWords] = useState("");

  /** The selection wrapped in a mark (or the mark taken off when it's already wrapped), the cursor kept on the words */
  const wrap = (m: Mark) => {
    const el = box.current;
    if (!el) return;
    const [a, b] = [el.selectionStart, el.selectionEnd];
    const picked = value.slice(a, b);
    const before = value.slice(0, a);
    const after = value.slice(b);
    const on = before.endsWith(m.open) && after.startsWith(m.close);
    const next = on ? `${before.slice(0, -m.open.length)}${picked}${after.slice(m.close.length)}` : `${before}${m.open}${picked || "text"}${m.close}${after}`;
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      const start = on ? a - m.open.length : a + m.open.length;
      el.setSelectionRange(start, start + (picked || (on ? "" : "text")).length);
    });
  };
  const insert = (text: string) => {
    const el = box.current;
    const [a, b] = el ? [el.selectionStart, el.selectionEnd] : [value.length, value.length];
    onChange(`${value.slice(0, a)}${text}${value.slice(b)}`);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(a + text.length, a + text.length);
    });
  };
  const openLink = () => {
    const el = box.current;
    setWords(el ? value.slice(el.selectionStart, el.selectionEnd) : "");
    setUrl("");
    setPanel(panel === "link" ? null : "link");
  };
  const addLink = () => {
    const u = url.trim();
    if (!/^(https?:\/\/|mailto:)\S+$/i.test(u)) return;
    const el = box.current;
    const [a, b] = el ? [el.selectionStart, el.selectionEnd] : [value.length, value.length];
    const link = `<${u}|${(words.trim() || u).replace(/[<>|]/g, "")}>`;
    onChange(`${value.slice(0, a)}${link}${value.slice(b)}`);
    setPanel(null);
  };
  const keys = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const m = MARKS.find((x) => x.key === e.key.toLowerCase() && x.key !== "s");
    if (m) {
      e.preventDefault();
      wrap(m);
    } else if (e.key.toLowerCase() === "k") {
      e.preventDefault();
      openLink();
    }
  };

  return (
    <div className="grid gap-2">
      <div role="toolbar" aria-label="Formatting" className="flex flex-wrap items-center gap-1 rounded-[12px] border border-line bg-surface-2 p-1">
        {MARKS.map((m) => (
          <button key={m.key} type="button" title={m.title} aria-label={m.title} onMouseDown={(e) => e.preventDefault()} onClick={() => wrap(m)} className={`grid h-11 w-11 place-items-center rounded-[9px] text-[15px] text-fg hover:bg-surface md:h-8 md:w-8 ${m.className}`}>
            {m.label}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-line" aria-hidden />
        <button type="button" title="Link (Ctrl+K)" aria-label="Add a link" aria-pressed={panel === "link"} onMouseDown={(e) => e.preventDefault()} onClick={openLink} className={`grid h-11 w-11 place-items-center rounded-[9px] hover:bg-surface md:h-8 md:w-8 ${panel === "link" ? "bg-surface text-fg" : "text-muted"}`}>
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M6.5 9.5a3 3 0 0 0 4.24 0l2.12-2.12a3 3 0 0 0-4.24-4.24l-.7.7M9.5 6.5a3 3 0 0 0-4.24 0L3.14 8.62a3 3 0 0 0 4.24 4.24l.7-.7" />
          </svg>
        </button>
        <button type="button" title="Emoji" aria-label="Add an emoji" aria-pressed={panel === "emoji"} onMouseDown={(e) => e.preventDefault()} onClick={() => setPanel(panel === "emoji" ? null : "emoji")} className={`grid h-11 w-11 place-items-center rounded-[9px] text-[16px] hover:bg-surface md:h-8 md:w-8 ${panel === "emoji" ? "bg-surface" : ""}`}>
          🙂
        </button>
        <button type="button" title="A bullet" aria-label="Add a bullet" onMouseDown={(e) => e.preventDefault()} onClick={() => insert("\n• ")} className="grid h-11 w-11 place-items-center rounded-[9px] text-[16px] text-muted hover:bg-surface md:h-8 md:w-8">
          •
        </button>
      </div>
      {panel === "link" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            addLink();
          }}
          className="grid gap-1.5 rounded-[12px] border border-line bg-surface p-2 sm:grid-cols-[1fr_1fr_auto]"
        >
          <input value={words} onChange={(e) => setWords(e.target.value)} placeholder="The words (optional)" className="h-11 rounded-[9px] border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text/60 md:h-9" />
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" inputMode="url" autoFocus className="h-11 rounded-[9px] border border-line bg-bg px-3 text-sm outline-none focus:border-brand-text/60 md:h-9" />
          <button type="submit" disabled={!/^(https?:\/\/|mailto:)\S+$/i.test(url.trim())} className="h-11 rounded-[9px] bg-fg px-3.5 text-[13px] text-bg disabled:opacity-40 md:h-9">
            Add link
          </button>
        </form>
      )}
      {panel === "emoji" && (
        <div className="grid grid-cols-8 gap-1 rounded-[12px] border border-line bg-surface p-2 sm:grid-cols-12">
          {EMOJI.map((e) => (
            <button key={e} type="button" onMouseDown={(ev) => ev.preventDefault()} onClick={() => insert(e)} className="grid h-11 place-items-center rounded-[8px] text-[18px] hover:bg-surface-2 md:h-9">
              {e}
            </button>
          ))}
        </div>
      )}
      <textarea ref={box} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={keys} rows={14} autoFocus aria-label="The message" className="w-full rounded-[14px] border border-brand/50 bg-surface px-4 py-3 text-[14px] leading-relaxed outline-none [field-sizing:content] focus:border-brand-text/60" />
    </div>
  );
}
