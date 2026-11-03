import Link from "next/link";
import type { Guide } from "@/lib/onboarding-guide-types";
import { PACING, STYLES } from "@/lib/onboarding-guide-types";

// A new client's setup, for the team: where each step of their onboarding guide stands (access checked against Meta
// and Google, assets, the look they picked), with the guide to open as they see it.

type Prep = { recap: string[]; prepare: string[]; at: string; reason: string };
type Blocker = { step: "meta" | "google"; kind: string; detail: string; at: string };
const BLOCKER_NAMES: Record<string, string> = { restricted: "Ad account restricted", no_permission: "No permission to give access", cant_create: "Can't create the account", verification: "Stuck on verification", billing: "Billing problem", other: "Needs our team" };

export function GuidePanel({ slug, guide, google, welcomed, launch, prep = null, blockers = [] }: { slug: string; guide: Guide; google: boolean; welcomed: string | null; launch: string | null; /** The CS team's brief for the onboarding call */ prep?: Prep | null; blockers?: Blocker[] }) {
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
      {(prep || blockers.length > 0) && (
        <div className="mt-1 grid gap-2.5 rounded-[16px] border border-warn/40 bg-warn-soft/20 p-3.5">
          <div className="flex flex-wrap items-baseline gap-2">
            <p className="text-[13.5px] font-medium">☎ For the onboarding call</p>
            {prep && <span className="text-[11.5px] text-faint">Updated {new Date(prep.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>}
          </div>
          {blockers.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {blockers.map((b) => (
                <span key={`${b.step}-${b.kind}`} title={b.detail} className="rounded-full bg-bad-soft px-2.5 py-1 text-[11.5px] font-medium text-bad">
                  {b.step === "meta" ? "Meta" : "Google"}: {BLOCKER_NAMES[b.kind] ?? b.kind}
                </span>
              ))}
            </div>
          )}
          {blockers.map((b) => (
            <p key={`d-${b.step}-${b.kind}`} className="text-[12.5px] text-muted">
              {b.detail}
            </p>
          ))}
          {prep && (
            <div className="grid gap-2 md:grid-cols-2">
              <div>
                <p className="text-[11px] uppercase tracking-[0.1em] text-faint">Where it stands</p>
                <ul className="mt-1 grid gap-1 text-[12.5px]">
                  {prep.recap.map((x) => (
                    <li key={x}>• {x}</li>
                  ))}
                </ul>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.1em] text-faint">Prepare</p>
                <ul className="mt-1 grid gap-1 text-[12.5px]">
                  {prep.prepare.map((x) => (
                    <li key={x}>→ {x}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}
      {row("Assets", files ? (guide.assets.driveNote ? "warn" : "ok") : "todo", files ? `${guide.assets.files ?? 0} files, ${guide.assets.links ?? 0} links${guide.assets.drive === "saved" ? " (in their Drive folder, Client uploads)" : ""}: in their documents below${guide.assets.driveNote ? `. Not in Drive: ${guide.assets.driveNote}` : ""}` : "Nothing shared yet")}
      {row("The look", looks.length || pace || guide.style.own?.length ? "ok" : "todo", looks.length || pace || guide.style.own?.length ? [looks.join(", "), pace && `${pace} pacing`, guide.style.liked?.length && `${guide.style.liked.length} examples liked`, guide.style.own?.length && `${guide.style.own.length} of their own examples`, guide.style.note && `"${guide.style.note.slice(0, 120)}"`].filter(Boolean).join(" · ") : "Not picked yet")}
      {(guide.style.own?.length ?? 0) > 0 && (
        <div className="flex flex-wrap gap-1.5 pb-2 pl-8">
          {guide.style.own!.map((x, i) => (
            <a key={`${x.url}-${i}`} href={x.url} target="_blank" rel="noreferrer" className="max-w-[240px] truncate rounded-full border border-line px-2.5 py-1 text-[11.5px] text-muted hover:text-fg">
              {x.kind === "link" ? "↗" : x.video ? "▶" : "▣"} {x.name}
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
