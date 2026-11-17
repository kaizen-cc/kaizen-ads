import Link from "next/link";

/**
 * Boards: the switch between the Creative Board and the Email Board, for the people who see both (the executives).
 * Each board is its own address, so back and forward walk between them.
 */
export function BoardSwitch({ active }: { active: "creative" | "email" }) {
  return (
    <nav aria-label="Boards" className="inline-flex rounded-full border border-line bg-surface p-1 text-[13px]">
      {(
        [
          ["creative", "Creative Board", "/board"],
          ["email", "Email Board", "/board/email"],
        ] as const
      ).map(([k, label, href]) => (
        <Link
          key={k}
          href={href}
          aria-current={active === k ? "page" : undefined}
          className={`grid h-8 place-items-center whitespace-nowrap rounded-full px-3.5 font-medium transition-colors max-md:h-10 ${active === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
