import { HOOK_GOOD, TONE_CLASS, VIDEO_HELP, WATCH_GOOD, videoTone } from "@/lib/kpi/video";

// A video ad's hook rate and how much of it people watch, colored against Kaizen's lines (hook 30%, watch 35%), each
// with its explanation on hover (and on tap, for phones: the badge takes focus).

type V = { hookRate: number | null; watchPct: number | null; avgWatchSec?: number | null; videoSeconds?: number | null };

function Badge({ label, value, good, help, detail, size, focusable }: { label: string; value: number | null; good: number; help: string; detail?: string | null; size: "sm" | "md"; focusable: boolean }) {
  const tone = videoTone(value, good);
  if (value == null) return null;
  const tip = `${help}${detail ? ` ${detail}` : ""}`;
  return (
    <span tabIndex={focusable ? 0 : undefined} aria-label={`${label} ${value}%. ${tip}`} className={`group/vm relative inline-flex items-center gap-1 rounded-full outline-none ${size === "sm" ? "px-1.5 py-px text-[10.5px]" : "px-2.5 py-1 text-xs"} ${tone ? TONE_CLASS[tone] : "bg-surface-2 text-muted"}`}>
      <span className="opacity-80">{label}</span>
      <span className="tabular font-medium">{value}%</span>
      <span role="tooltip" className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-30 hidden w-60 -translate-x-1/2 rounded-[10px] border border-line bg-bg px-3 py-2 text-left text-[11px] font-normal leading-snug text-muted shadow-lg group-hover/vm:block group-focus/vm:block">
        {help}
        {detail && <span className="mt-1 block text-fg">{detail}</span>}
      </span>
    </span>
  );
}

/** focusable false inside a button or link (the card itself is the control; hover still explains) */
export function VideoMetrics({ v, size = "sm", focusable = true }: { v: V; size?: "sm" | "md"; focusable?: boolean }) {
  if (v.hookRate == null && v.watchPct == null) return null;
  const watched = v.avgWatchSec != null && v.videoSeconds ? `Watched ${v.avgWatchSec}s of ${v.videoSeconds}s on average.` : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge label="Hook" value={v.hookRate} good={HOOK_GOOD} help={VIDEO_HELP.hook} size={size} focusable={focusable} />
      <Badge label="Watched" value={v.watchPct} good={WATCH_GOOD} help={VIDEO_HELP.watch} detail={watched} size={size} focusable={focusable} />
    </span>
  );
}
