import type { ItemContextLine } from "@/lib/exec-overview-core";

// Enough to act right there (Nov 24 2026): the conversation behind an item (the client's messages and ours, who and
// when, oldest first) or the exact words promised, quoted on the item itself, on the Overview and in the recap.

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) : null);

export function ItemContext({ lines, dark = false }: { lines: ItemContextLine[]; dark?: boolean }) {
  if (!lines.length) return null;
  return (
    <ol className="grid gap-2" aria-label="The conversation">
      {lines.map((l, i) => (
        <li key={i} className={`grid gap-0.5 rounded-[14px] px-3 py-2 ${l.ours ? (dark ? "bg-white/[0.04]" : "bg-ink/[0.03]") : dark ? "border-l-2 border-white/30 bg-white/[0.07]" : "border-l-2 border-ink/25 bg-ink/[0.06]"}`}>
          <span className={`text-[11.5px] ${dark ? "text-white/50" : "text-ink/55"}`}>
            <span className={dark ? "text-white/80" : "text-ink/80"}>{l.from}</span>
            {l.ours ? " (us)" : ""}
            {when(l.at) ? ` · ${when(l.at)}` : ""}
          </span>
          <span className={`whitespace-pre-wrap text-[13.5px] leading-relaxed [overflow-wrap:anywhere] ${dark ? "text-white/85" : "text-fg"}`}>{l.text}</span>
        </li>
      ))}
    </ol>
  );
}
