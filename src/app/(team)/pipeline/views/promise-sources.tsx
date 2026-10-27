import type { PromiseGroup } from "@/lib/promise-groups";

// Where a grouped promise was talked about (calls, Slack, email) and what those conversations added, under its card.

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });

export function PromiseSources({ group }: { group: PromiseGroup | null }) {
  if (!group || (group.sources.length < 2 && !group.context)) return null;
  return (
    <div className="grid gap-2 rounded-[12px] border border-line bg-surface/60 p-3">
      {group.sources.length > 1 && (
        <div className="grid gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-faint">Talked about in {group.sources.length} places</span>
          <div className="flex flex-wrap gap-1.5">
            {group.sources.map((s, i) =>
              s.url ? (
                <a key={i} href={s.url} target="_blank" rel="noreferrer" className="inline-flex min-h-8 max-w-full items-center truncate rounded-full border border-line px-2.5 text-[11px] text-muted hover:text-fg max-md:min-h-9">
                  {s.label} · {day(s.at)} ↗
                </a>
              ) : (
                <span key={i} className="inline-flex min-h-8 max-w-full items-center truncate rounded-full border border-line px-2.5 text-[11px] text-muted max-md:min-h-9">
                  {s.label} · {day(s.at)}
                </span>
              ),
            )}
          </div>
        </div>
      )}
      {group.context && <p className="text-xs leading-relaxed text-muted">{group.context}</p>}
    </div>
  );
}
