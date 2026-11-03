import Link from "next/link";
import type { Guide, GuideHas, ToolStep } from "@/lib/onboarding-guide-types";
import { EMAIL_PLATFORMS, GOOGLE_TOOLS, PACING, STEP_LABELS, STYLES, WEBSITE_PLATFORMS, accessLeft, callType, googleTools } from "@/lib/onboarding-guide-types";
import { TRACKING_KINDS, trackingPlatform } from "@/lib/tracking-platforms";
import { CopyChip } from "./copy-chip";

// A new client's setup, for the team: where each step of their onboarding guide stands (access checked against Meta
// and Google, assets, the look they picked), with the guide to open as they see it.

type Prep = { recap: string[]; prepare: string[]; at: string; reason: string };
type Blocker = { step: string; kind: string; detail: string; at: string };
const BLOCKER_NAMES: Record<string, string> = { restricted: "Ad account restricted", no_permission: "No permission to give access", cant_create: "Can't create the account", verification: "Stuck on verification", billing: "Billing problem", other: "Needs our team" };

export function GuidePanel({ slug, guide, google, has = null, welcomed, launch, prep = null, blockers = [] }: { slug: string; guide: Guide; google: boolean; /** Which steps they have (Google tools, website, email, where sales live) */ has?: GuideHas | null; welcomed: string | null; launch: string | null; /** The CS team's brief for the onboarding call */ prep?: Prep | null; blockers?: Blocker[] }) {
  const row = (label: string, state: "ok" | "warn" | "todo" | "call", text: string) => (
    <div className="flex items-start gap-3 border-t border-line py-2.5 first:border-t-0">
      <span className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] ${state === "ok" ? "bg-ok-soft text-ok" : state === "warn" ? "bg-warn-soft text-warn" : state === "call" ? "bg-brand/15 text-brand-text" : "bg-surface-2 text-muted"}`}>{state === "ok" ? "✓" : state === "call" ? "☎" : state === "warn" ? "!" : "·"}</span>
      <div className="grid min-w-0 gap-0.5">
        <p className="text-[13.5px]">{label}</p>
        <p className="text-[12.5px] text-muted">{text}</p>
      </div>
    </div>
  );
  // A tool, website, email or tracking step: added (the team checks), on the call, not needed, or not yet
  const toolRow = (label: string, t: ToolStep, added: string) =>
    row(label, t.status === "done" ? "ok" : t.status === "na" ? "ok" : t.status === "on_call" ? "call" : "todo", t.status === "done" ? added : t.status === "na" ? "Not needed" : t.status === "on_call" ? (t.none ? "They don't have one: set it up on the onboarding call" : `Covering it on the call${t.note ? `: "${t.note}"` : ""}`) : "Not yet");
  const tools = has ? googleTools(guide, has) : [];
  const left = has ? accessLeft(guide, has, blockers) : null;
  const w = guide.website ?? {};
  const e = guide.email ?? {};
  const tr = guide.tracking ?? {};
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
      {tools.map((t) => toolRow(GOOGLE_TOOLS.find((x) => x.key === t)!.name, guide[t] ?? {}, `They added our tech address${guide[t]?.id ? ` (${guide[t].id})` : ""}: accept the invite and check access`))}
      {has?.tracking &&
        row(
          TRACKING_KINDS[has.tracking].title,
          tr.status === "done" ? "ok" : tr.status === "on_call" ? "call" : tr.picks?.length ? "warn" : "todo",
          tr.notSure && !tr.picks?.length
            ? "Not sure where sales are recorded: work it out on the onboarding call"
            : tr.picks?.length
              ? tr.picks.map((x) => `${x.name}: ${x.status === "done" ? "added us" : x.status === "on_call" ? "on the call (report export or connection)" : "to add us"}${x.status !== "done" ? ` (needs: ${trackingPlatform(x.key)?.needs ?? "orders, bookings or leads by day and source"})` : ""}`).join(" · ")
              : "Not picked yet",
        )}
      {has?.website && (
        <>
          {toolRow(`Website${w.platform ? `: ${WEBSITE_PLATFORMS.find((x) => x.key === w.platform)?.name ?? w.platform}` : ""}`, w, w.platform === "shopify" ? `Send the collaborator request to ${w.store} with code ${w.code} (Shopify Partners › Stores › Add store › Request access), then they accept it` : `They invited our tech address${w.url ? ` on ${w.url}` : ""}: accept it and check access`)}
          {w.platform === "shopify" && w.status === "done" && w.store && w.code && (
            <div className="flex flex-wrap items-center gap-1.5 pb-2 pl-8">
              <CopyChip value={w.store} />
              <CopyChip value={w.code} label="Code" />
              <a href="https://partners.shopify.com/" target="_blank" rel="noreferrer" className="text-[12.5px] text-brand-text hover:underline">
                Shopify Partners ↗
              </a>
            </div>
          )}
        </>
      )}
      {has?.email && toolRow(`Email platform${e.platform ? `: ${EMAIL_PLATFORMS.find((x) => x.key === e.platform)?.name ?? e.platform}` : ""}`, e, `They invited our ${e.platform === "klaviyo" ? "Klaviyo" : "tech"} address: accept it and check access`)}
      {left && left.left > 0 && (
        <p className="pl-8 text-[12px] text-faint">
          Access still to share: {left.items.map((k) => STEP_LABELS[k] ?? k).join(", ")} · the onboarding call to book: {callType(left) === "dfy" ? "done-for-you" : "done-with-you"}
        </p>
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
                  {STEP_LABELS[b.step] ?? b.step}: {BLOCKER_NAMES[b.kind] ?? b.kind}
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
