import { objectLink, type AuditObject } from "@/lib/chat-change-core";

// "Open in Ads Manager ↗" / "Open in Google Ads ↗" on an audit action, a sprint move or a planned change: straight to
// the campaign, ad set or ad it names, so the buyer can check where it lives and watch it change.

const TYPE: Record<AuditObject["type"], string> = { campaign: "Campaign", adset: "Ad set", ad: "Ad", ad_group: "Ad group", keyword: "Keyword" };
const where = (p: AuditObject["platform"]) => (p === "google" ? "Google Ads" : "Ads Manager");

export function ObjectLinks({ objects, className = "" }: { objects?: AuditObject[] | null; className?: string }) {
  const list = (objects ?? []).filter((o) => o?.id && o.account);
  if (!list.length) return null;
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-1.5 ${className}`}>
      <span className="text-[11px] text-faint">Open in {where(list[0].platform)}:</span>
      {list.map((o) => (
        <a key={`${o.type}:${o.id}`} href={objectLink(o)} target="_blank" rel="noreferrer" title={`${TYPE[o.type]} "${o.name}"`} className="inline-flex min-h-11 min-w-0 max-w-full items-center gap-1 rounded-full border border-line px-3 text-[12px] text-muted transition-colors hover:border-fg/30 hover:text-fg md:min-h-7 md:max-w-[260px] md:px-2.5 md:text-[11px]">
          <span className="shrink-0 text-faint">{TYPE[o.type]}</span>
          <span className="truncate">{o.name}</span>
          <span aria-hidden className="shrink-0">
            ↗
          </span>
        </a>
      ))}
    </div>
  );
}

/** One link for a planned change's object */
export function OpLink({ href, platform }: { href: string | null; platform: "meta" | "google" }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1 justify-self-start text-[12px] text-muted hover:text-fg md:min-h-0 md:text-[11px]">
      Open in {platform === "google" ? "Google Ads" : "Ads Manager"} <span aria-hidden>↗</span>
    </a>
  );
}
