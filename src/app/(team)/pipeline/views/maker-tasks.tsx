import type { MakerTask } from "@/lib/maker-day";
import { daysBetween, whenLabel } from "@/lib/maker-day-core";

/**
 * A maker's tasks, under their recap (graphic designers and video editors): every open piece assigned to them, their
 * Asana creative tasks and any Kaizen board tickets, overdue first then due soonest. One tap opens the task in Asana
 * (or the ticket on the board). Pieces with someone else right now (review, copy, the client) show quieter.
 */
export function MakerTasks({ tasks }: { tasks: MakerTask[] }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const onYou = tasks.filter((t) => t.onThem).length;
  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-heading text-xl">
          Your tasks <span className="tabular text-[15px] text-faint">{tasks.length}</span>
        </h2>
        <span className="text-xs text-faint">{onYou ? `${onYou} waiting on you · overdue first` : "Overdue first, then due soonest"}</span>
      </div>
      {tasks.length ? (
        <ul className="grid gap-px overflow-hidden rounded-[20px] border border-line bg-line">
          {tasks.map((t) => {
            const d = t.due ? daysBetween(today, t.due) : null;
            const tone = d != null && d < 0 ? "text-bad" : d === 0 ? "text-warn" : "text-muted";
            const external = t.kind === "asana" || t.kind === "email_asana";
            return (
              <li key={t.key}>
                <a
                  href={t.href}
                  {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
                  className={`flex min-h-14 flex-col gap-1.5 bg-surface px-4 py-3 transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4 md:px-5 ${t.onThem ? "" : "opacity-70"}`}
                >
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="truncate text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{t.client || "No client"}</span>
                    <span className="line-clamp-2 text-[15px] leading-snug text-fg">{t.title}</span>
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-1.5 text-[12px]">
                    <span className={`font-medium ${tone}`}>{whenLabel(t.due, today)}</span>
                    <span className={`rounded-full px-2 py-0.5 ${t.stage === "client_revision" ? "bg-warn-soft text-warn" : "bg-ink/[0.06] text-muted"}`}>{t.stageLabel}</span>
                    {t.revisions > 0 && (
                      <span className="rounded-full bg-ink/[0.06] px-2 py-0.5 text-muted">
                        {t.revisions} {t.revisions === 1 ? "revision" : "revisions"}
                      </span>
                    )}
                    <span className="text-faint" aria-hidden>
                      {external ? "↗" : "→"}
                    </span>
                    {external && <span className="sr-only">Opens in Asana</span>}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="rounded-[16px] border border-dashed border-line px-4 py-5 text-sm text-muted">Nothing assigned to you right now. New work shows here the moment it&apos;s on you.</p>
      )}
    </section>
  );
}
