import Link from "next/link";

// The shot list on the client's home and dashboard: what we need from them for next cycle, until it's all in.
export function ShotsBanner({ slug, month, open, total, slim = false }: { slug: string; month: string; open: number; total: number; slim?: boolean }) {
  if (!open) return null;
  if (slim)
    return (
      <Link href={`/c/${slug}/shots`} className="flex items-center gap-3 rounded-[18px] border border-brand/40 bg-brand/[0.07] px-4 py-3 transition-colors hover:border-brand">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-[13px] font-semibold text-white">{open}</span>
        <span className="min-w-0 flex-1 text-[13.5px]">
          <span className="font-medium">Our team needs new footage for {month}</span>
          <span className="text-muted"> · fresh creative is how your ads keep finding new customers</span>
        </span>
        <span className="shrink-0 text-[13px] text-brand-text">Send it →</span>
      </Link>
    );
  return (
    <Link href={`/c/${slug}/shots`} className="group grid gap-3 rounded-[24px] border border-brand/40 bg-brand/[0.07] p-5 transition-colors hover:border-brand">
      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">Your shot list · {month}</span>
      <span className="font-heading text-[17px] leading-snug">
        {open} {open === 1 ? "shot" : "shots"} we need from you{total > open ? ` (${total - open} in, thank you)` : ""}
      </span>
      <span className="text-[13px] text-muted">Phone photos and clips are perfect. Upload each one right on the list.</span>
      <span className="text-[13px] text-brand-text">Open the list →</span>
    </Link>
  );
}
