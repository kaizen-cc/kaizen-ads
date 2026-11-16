import Link from "next/link";
import { type lineOfTeam } from "@/lib/roles";

/**
 * What the email and organic social teams see where the KPIs and reports will be: their own KPIs and reports are the
 * next step, so for now a calm empty state that points them at their clients (never an error, never ad numbers).
 */
export function ChannelSoon({ what, line }: { what: "KPIs" | "Reports"; line: ReturnType<typeof lineOfTeam> }) {
  const channel = line === "social" ? "Social" : "Email";
  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <header>
        <h1 className="font-heading text-3xl md:text-4xl">{what}</h1>
        <p className="mt-2 text-sm text-muted">{channel} {what} are coming.</p>
      </header>
      <div className="grid justify-items-start gap-4 rounded-[18px] border border-line bg-surface p-6 md:p-8">
        <span aria-hidden className="grid h-11 w-11 place-items-center rounded-full bg-brand-soft text-brand-text">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 19h16M6 15l4-5 3 3 5-7" />
          </svg>
        </span>
        <div className="grid gap-1.5">
          <p className="font-heading text-xl">{channel} {what} are coming</p>
          <p className="max-w-prose text-sm leading-relaxed text-muted">
            {what === "KPIs" ? `Targets and how each client is doing against them will live here for ${channel.toLowerCase()}.` : `Each client's ${channel.toLowerCase()} report will be drafted and sent from here.`} Until then, everything about your clients is on their pages: the
            {line === "social" ? " Social panel" : " Email panel"}, the Brand Bible, calls, notes and documents.
          </p>
        </div>
        <Link href="/clients" className="inline-flex min-h-11 items-center rounded-full bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover">
          Open your clients
        </Link>
      </div>
    </div>
  );
}
