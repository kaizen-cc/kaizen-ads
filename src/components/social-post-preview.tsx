"use client";

import { HoverCard } from "@/components/hover-card";

// A social post on hover (Head of Social, Nov 19 2026): the picture at a readable size, the whole caption and every
// number we have for it, with a link to the post itself. The client page's Social tab and the KPI client sheet use the
// same card. On a phone the tap opens the same card as a sheet, with "Open the post" as its main action.

export type PreviewPost = {
  platform: string;
  format: string | null;
  postedAt: string | null;
  caption: string | null;
  permalink: string | null;
  thumbnail?: string | null;
  reach?: number | null;
  views?: number | null;
  interactions?: number | null;
  likes?: number | null;
  comments?: number | null;
  saves?: number | null;
  shares?: number | null;
  rate?: number | null;
};

const NAME: Record<string, string> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", linkedin: "LinkedIn" };
const FORMAT: Record<string, string> = { reel: "Reel", video: "Video", carousel: "Carousel", image: "Image", link: "Link", text: "Text", story: "Story" };
const n = (v: number | null | undefined) => (v == null ? null : v >= 10_000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toLocaleString("en-US"));
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" }) : "Undated");

export function PostPreviewCard({ p }: { p: PreviewPost }) {
  const stats = (
    [
      ["Reach", n(p.reach)],
      ["Views", n(p.views)],
      ["Interactions", n(p.interactions)],
      ["Rate", p.rate == null ? null : `${(p.rate * 100).toFixed(1)}%`],
      ["Likes", n(p.likes)],
      ["Comments", n(p.comments)],
      ["Saves", n(p.saves)],
      ["Shares", n(p.shares)],
    ] as const
  ).filter(([, v]) => v != null);
  return (
    <span className="grid gap-3">
      {p.thumbnail ? (
        // A platform's signed thumbnail URL: a plain img, shown whole (never cropped)
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.thumbnail} alt="" className="max-h-64 w-full rounded-[12px] border border-line bg-surface-2 object-contain" loading="lazy" />
      ) : (
        <span aria-hidden className="grid h-28 place-items-center rounded-[12px] border border-dashed border-line text-[11px] uppercase tracking-[0.12em] text-faint">
          No picture read
        </span>
      )}
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-faint">
        <span className="font-medium text-fg">{NAME[p.platform] ?? p.platform}</span>
        <span>· {FORMAT[p.format ?? ""] ?? p.format ?? "Post"}</span>
        <span>· {day(p.postedAt)}</span>
      </span>
      <span className="line-clamp-6 whitespace-pre-line text-[12.5px] leading-relaxed text-fg/90 [overflow-wrap:anywhere]">{p.caption?.trim() || "No caption"}</span>
      {stats.length > 0 && (
        <span className="grid grid-cols-4 gap-x-3 gap-y-2 border-t border-line pt-2.5">
          {stats.map(([k, v]) => (
            <span key={k} className="grid gap-0.5">
              <span className="text-[10px] uppercase tracking-[0.1em] text-faint">{k}</span>
              <span className="tabular text-[13px] text-fg">{v}</span>
            </span>
          ))}
        </span>
      )}
      {p.permalink && (
        <a href={p.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-10 w-fit items-center rounded-full bg-fg px-4 text-[12px] font-medium text-bg md:min-h-8">
          Open on {NAME[p.platform] ?? "the platform"} ↗
        </a>
      )}
    </span>
  );
}

/** A post row with its preview on hover (a tap on a phone) */
export function PostHover({ p, children, className = "block w-full" }: { p: PreviewPost; children: React.ReactNode; className?: string }) {
  return (
    <HoverCard content={<PostPreviewCard p={p} />} width={360} className={className}>
      {children}
    </HoverCard>
  );
}
