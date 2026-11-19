import { BAND_TONE } from "@/components/email-score-parts";
import { basisLabel } from "@/lib/social/rate";
import { PLATFORM_LABEL, socialCheckText, type SocialAccountCheckKey, type SocialCheck, type SocialDrag } from "@/lib/social-score";

// How the social account score looks everywhere (the Social board, its sheet, the Overview): the checks against their
// bars, what weighs the score down (per platform), and why each check matters. The colours and the badge are email's
// (src/components/email-score-parts.tsx), so a green social account looks like a green email account. Server-safe.

export { BAND_TONE };

/** Why each check is in the score and what moves it: the sheet's "why" under each check */
export const CHECK_WHY: Record<SocialAccountCheckKey, { what: string; moves: string }> = {
  engagement: { what: "Interactions (likes, comments, shares, saves) over reach, the last 30 days, against the client's own target. With no reach from Meta it is over views, then per post over followers, each against its own bar (3% and 1%), so rates on different bases are never compared.", moves: "Stronger hooks in the first line and the first second, posts that ask for a reply or a save, and more of the formats this account's best posts use." },
  growth: { what: "Net new followers over the 30 days, as a share of where the account started.", moves: "Reels that reach beyond the followers, a reason to follow in the bio and captions, collaborations and shares." },
  reach: { what: "The 30 days' reach against the 30 before (holding level meets the bar).", moves: "Posting steadily, Reels and video (the platforms push them to non-followers), and topics that already earned reach." },
  cadence: { what: "Posts published this month against what the package promises for the month so far.", moves: "A content calendar a week ahead, batching creative, and approvals that don't wait on the client." },
  quality: { what: "Saves and shares over reach: the engagement that says a post was worth keeping or sending.", moves: "Carousels people save (how-tos, lists, before and after), posts made to be sent to a friend." },
  videoShare: { what: "The share of posts that are video or Reels.", moves: "Turning the best statics into short video, a Reel a week at least." },
  videoLift: { what: "Engagement on video and Reels against static posts (level or better meets the bar).", moves: "Hooks in the first second, captions on screen, and lengths that fit the platform." },
  profile: { what: "Profile visits over reach: people curious enough to look closer.", moves: "Clear calls to visit the profile, a reason to click the link, consistent visuals people recognise." },  allotment: { what: "The share of this billing cycle's social allotment delivered (posts, statics, video/reels and IG stories published on the platforms they post on, plus what's requested) against how far through the cycle they are. The first days of a cycle, strategy-only clients and clients with no tier are left out.", moves: "Plan the month's calendar against the tier at the start of the cycle, batch the creative, and post on every platform the client buys." },
};

/** The checks, compact: met or not, the value against the bar, and why on a tap (a native details, no script) */
export function SocialChecks({ checks, why = false }: { checks: SocialCheck[]; why?: boolean }) {
  return (
    <ul className="grid gap-1.5">
      {checks.map((c) => {
        const measured = c.value != null;
        const tone = !measured ? "text-faint" : c.met ? "text-ok" : "text-bad";
        const row = (
          <span className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-x-2 text-[12.5px]">
            <span className={`${tone} text-[13px]`} aria-label={!measured ? "No data" : c.met ? "Met" : "Under the bar"}>
              {!measured ? "-" : c.met ? "✓" : "✗"}
            </span>
            <span className="min-w-0 truncate text-fg">
              {c.label}
              {c.key === "engagement" && basisLabel(c.basis) ? <span className="text-faint"> · {basisLabel(c.basis)}</span> : null}
            </span>
            <span className="tabular text-right">
              <span className={tone}>{socialCheckText(c.unit, c.value)}</span>
              <span className="text-faint"> / bar {socialCheckText(c.unit, c.bar)}</span>
            </span>
          </span>
        );
        return (
          <li key={c.key}>
            {why ? (
              <details className="group">
                <summary className="flex min-h-11 cursor-pointer list-none items-center md:min-h-0 [&::-webkit-details-marker]:hidden">
                  <span className="w-full">{row}</span>
                </summary>
                <span className="mb-1.5 ml-[26px] mt-1 grid gap-1 rounded-[10px] bg-bg/60 px-3 py-2 text-[12px] leading-relaxed text-muted">
                  <span>{CHECK_WHY[c.key].what}</span>
                  <span className="text-faint">
                    {c.weight} of 100 points.{measured ? (c.met ? " Met." : ` Costing ${Math.max(1, Math.round(c.weight - c.points))}.`) : " Nothing to measure yet, so it's left out and the rest scaled up."} What moves it: {CHECK_WHY[c.key].moves}
                  </span>
                </span>
              </details>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The top drags on the score, each with its platform and the points it costs the overall */
export function SocialWeighingDown({ drags, limit = 3 }: { drags: SocialDrag[]; limit?: number }) {
  const list = drags.slice(0, limit);
  if (!list.length) return <p className="text-[12.5px] text-ok">Every check is at or over its bar.</p>;
  return (
    <div className="grid gap-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Weighing it down</p>
      <ul className="grid gap-1">
        {list.map((c) => (
          <li key={`${c.platform}:${c.key}`} className="flex items-baseline justify-between gap-3 text-[12.5px]">
            <span className="min-w-0 truncate text-fg">
              <span className="text-muted">{PLATFORM_LABEL[c.platform]}</span> {c.label.toLowerCase()}{" "}
              <span className="tabular text-faint">
                {socialCheckText(c.unit, c.value)} vs {socialCheckText(c.unit, c.bar)}
              </span>
            </span>
            <span className="tabular shrink-0 text-bad">-{Math.max(1, Math.round(c.cost))} pts</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
