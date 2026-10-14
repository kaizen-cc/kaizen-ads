// Shared form and card styles, so every screen has the same field height, radius and spacing.

export const field =
  "h-10 w-full min-w-0 rounded-[8px] border border-line bg-bg px-3 text-sm text-fg outline-none transition-colors placeholder:text-faint hover:border-faint/60 focus:border-brand-text/70 disabled:opacity-60";
export const label = "grid gap-1.5 text-xs font-medium text-muted";

/** A card with a title, an optional line under it, and an optional action on the right. */
export function Section({
  title,
  description,
  action,
  className = "",
  children,
}: {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`grid min-w-0 content-start gap-5 rounded-[12px] border border-line bg-surface p-6 [overflow-wrap:break-word] ${className}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-[17px]">{title}</h2>
          {description && <p className="mt-1 text-sm leading-relaxed text-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}
