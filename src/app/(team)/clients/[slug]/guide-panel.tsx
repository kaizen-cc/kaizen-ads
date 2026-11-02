import Link from "next/link";
import type { Guide } from "@/lib/onboarding-guide-types";
import { PACING, STYLES } from "@/lib/onboarding-guide-types";

// A new client's setup, for the team: where each step of their onboarding guide stands (access checked against Meta
// and Google, assets, the look they picked), with the guide to open as they see it.

export function GuidePanel({ slug, guide, google, welcomed, launch }: { slug: string; guide: Guide; google: boolean; welcomed: string | null; launch: string | null }) {
  const row = (label: string, state: "ok" | "warn" | "todo" | "call", text: string) => (
    <div className="flex items-start gap-3 border-t border-line py-2.5 first:border-t-0">
      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] ${state === "ok" ? "bg-ok-soft text-ok" : state === "warn" ? "bg-warn-soft text-warn" : state === "call" ? "bg-brand/15 text-brand-text" : "bg-surface-2 text-muted"}`}>{state === "ok" ? "✓" : state === "call" ? "☎" : state === "warn" ? "!" : "·"}</span>
      <div className="grid min-w-0 gap-0.5">
        <p className="text-[13.5px]">{label}</p>
        <p className="text-[12.5px] text-muted">{text}</p>
      </div>
    </div>
  );
  const m = guide.meta;
  const g = guide.google;
  const files = (guide.assets.files ?? 0) + (guide.assets.links ?? 0);
  const looks = (guide.style.styles ?? []).map((k) => STYLES.find((x) => x.key === k)?.name).filter(Boolean);
  const pace = PACING.find((x) => x.key === guide.style.pacing)?.name;
  return (
    <section className="grid gap-2 rounded-[20px] border border-line bg-surface p-4 md:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="font-heading text-[16px]">Their setup</p>
        <span className="text-[12px] text-faint">{welcomed ? `Guide sent ${new Date(welcomed).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : "Guide not sent yet (it goes out at enrollment, once Kaizen's Business Manager ID is set)"}</span>
        <Link href={`/c/${slug}/start`} className="ml-auto text-[12.5px] text-brand-text hover:underline">
          Open their guide ↗
        </Link>
        {launch && (
          <Link href={`/clients/${slug}/launch`} className="text-[12.5px] text-brand-text hover:underline">
            First ads →
          </Link>
        )}
      </div>
      {row(
        "Meta access",
        m.status === "verified" ? (m.note ? "warn" : "ok") : m.status === "on_call" ? "call" : m.status === "done" ? "warn" : "todo",
        m.status === "verified" ? `${m.accountName ?? m.account} and ${m.pageName ?? "their Page"} shared with Kaizen${m.note ? `. ${m.note}` : ""}` : m.status === "on_call" ? `Covering it on the onboarding call${m.note ? `: "${m.note}"` : ""}` : m.status === "done" ? `They say it's shared; ${m.note ?? "we can't see it yet"} (checked every 30 minutes)` : "Not started",
      )}
      {google &&
        row(
          "Google Ads",
          g.status === "verified" ? "ok" : g.status === "on_call" ? "call" : g.account ? "warn" : "todo",
          g.status === "verified" ? `${g.account} linked to our manager account` : g.status === "on_call" ? `Covering it on the call${g.note ? `: "${g.note}"` : ""}` : g.account ? `ID ${g.account}: ${g.note ?? "waiting on the link"}` : "No account ID yet",
        )}
      {row("Assets", files ? "ok" : "todo", files ? `${guide.assets.files ?? 0} files, ${guide.assets.links ?? 0} links${guide.assets.drive === "saved" ? " (in their Drive folder, Client uploads)" : ""}: in their documents below` : "Nothing shared yet")}
      {row("The look", looks.length || pace ? "ok" : "todo", looks.length || pace ? [looks.join(", "), pace && `${pace} pacing`, guide.style.liked?.length && `${guide.style.liked.length} examples liked`, guide.style.note && `"${guide.style.note.slice(0, 120)}"`].filter(Boolean).join(" · ") : "Not picked yet")}
    </section>
  );
}
