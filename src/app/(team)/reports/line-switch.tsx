import Link from "next/link";

// Execs report on every line: the Reports page switches between Ads, Email and Social (in the address, so back returns).
export function LineSwitch({ current }: { current: "ads" | "email" | "social" }) {
  const items = [
    { key: "ads", label: "Ads" },
    { key: "email", label: "Email" },
    { key: "social", label: "Social" },
  ] as const;
  return (
    <nav aria-label="Report line" className="inline-flex w-fit rounded-full border border-line bg-surface p-1">
      {items.map((i) => (
        <Link key={i.key} href={i.key === "ads" ? "/reports" : `/reports?line=${i.key}`} scroll={false} aria-current={current === i.key ? "page" : undefined} className={`inline-flex h-11 items-center rounded-full px-5 text-sm transition-colors md:h-9 ${current === i.key ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
