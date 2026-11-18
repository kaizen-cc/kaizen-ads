import type { themeBreakdown } from "@/lib/profile";

// Execs: who on the team uses light, dark or the device's own setting. A person who never chose sees the app's default
// (dark), so they're counted apart rather than guessed into one of the three.

const ROWS = [
  { key: "dark", label: "Dark" },
  { key: "light", label: "Light" },
  { key: "system", label: "System" },
  { key: "unset", label: "Not chosen" },
] as const;

export function ThemeUse({ counts }: { counts: ReturnType<typeof themeBreakdown> }) {
  if (!counts.total) return null;
  return (
    <section aria-label="Appearance on the team" className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-heading text-[16px]">Light or dark</h2>
        <p className="text-xs text-faint">{counts.total} people on the team</p>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" role="img" aria-label={ROWS.map((r) => `${r.label}: ${counts[r.key]}`).join(", ")}>
        {ROWS.map((r, i) => (counts[r.key] ? <span key={r.key} style={{ width: `${(counts[r.key] / counts.total) * 100}%` }} className={["bg-brand", "bg-warn", "bg-ok", "bg-faint/50"][i]} /> : null))}
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {ROWS.map((r, i) => (
          <li key={r.key} className="flex items-center gap-2.5 rounded-[12px] border border-line px-3 py-2.5">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${["bg-brand", "bg-warn", "bg-ok", "bg-faint/50"][i]}`} />
            <span className="min-w-0 flex-1 text-[13px] text-muted">{r.label}</span>
            <span className="font-heading text-[16px]">{counts[r.key]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
