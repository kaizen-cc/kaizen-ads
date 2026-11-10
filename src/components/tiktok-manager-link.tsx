import { tiktokManagerLink } from "@/lib/tiktok/audit-core";

// Where a TikTok move is made: TikTok is read only in Kaizen Ads, so an audit action or sprint move on a TikTok account
// gets this link (the account in TikTok Ads Manager) instead of a "Make this change" button.

export function TikTokManagerLink({ advertiserId, className = "" }: { advertiserId: string | null | undefined; className?: string }) {
  return (
    <div className={`grid gap-1 rounded-[12px] border border-line bg-bg/40 px-3 py-2.5 ${className}`}>
      <a href={tiktokManagerLink(advertiserId)} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 justify-self-start text-[13px] font-medium hover:underline md:min-h-0">
        Open in TikTok Ads Manager <span aria-hidden>↗</span>
      </a>
      <p className="text-[11.5px] leading-relaxed text-faint">TikTok is read only here: make the change there, then mark it done.</p>
    </div>
  );
}
