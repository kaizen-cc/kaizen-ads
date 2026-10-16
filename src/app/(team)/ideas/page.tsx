import type { Metadata } from "next";
import Link from "next/link";
import Market from "../market/page";
import Winners from "../winners/page";

export const metadata: Metadata = { title: "Ideas" };

// The strategist writes a full brief from a winner or a market ad while the person waits
export const maxDuration = 300;

const TABS = [
  ["winners", "Our winners", "What's beating its own account across our clients"],
  ["market", "In the market", "Live Meta ads from comparable brands, from Motion"],
] as const;

/** Where ideas come from: what's working in our accounts, and what's working out in the market. */
export default async function Ideas({ searchParams }: PageProps<"/ideas">) {
  const sp = await searchParams;
  const tab = sp.tab === "market" ? "market" : "winners";
  // Keep the client (and anything else) when switching tabs
  const keep = (t: string) => {
    const q = new URLSearchParams();
    q.set("tab", t);
    if (typeof sp.client === "string") q.set("client", sp.client);
    return `/ideas?${q.toString()}`;
  };
  return (
    <div className="grid gap-6">
      <nav className="mx-auto flex w-full max-w-6xl gap-1 rounded-full border border-line bg-surface p-1 sm:w-fit" aria-label="Ideas">
        {TABS.map(([k, label, hint]) => (
          <Link
            key={k}
            href={keep(k)}
            title={hint}
            aria-current={tab === k ? "page" : undefined}
            className={`flex-1 rounded-full px-4 py-2 text-center text-sm transition-colors sm:flex-none ${tab === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {tab === "market" ? <Market {...({ searchParams, params: Promise.resolve({}) } as unknown as PageProps<"/market">)} /> : <Winners />}
    </div>
  );
}
