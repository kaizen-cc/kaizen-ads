import { PRIORITY_LABEL, type PriorityLevel } from "@/lib/task-title";

/**
 * The one priority badge (tickets and Asana tasks alike): High or Urgent, nothing for Normal. Same words, same colors
 * everywhere, whatever Asana called it ("Hi", "URGENT: URGENT:").
 */
export function PriorityBadge({ priority, size = "sm" }: { priority: PriorityLevel | null | undefined; size?: "sm" | "md" }) {
  if (!priority || priority === "normal") return null;
  const tone = priority === "urgent" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn";
  const dims = size === "md" ? "px-2 py-0.5 text-[11px]" : "px-1.5 py-px text-[11px] md:text-[10px]";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full font-semibold ${dims} ${tone}`}>
      {priority === "urgent" && <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-bad" />}
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
