import "server-only";
import { asksInStyle } from "./custom-core";
import { customAnalysis, type MetaTarget } from "./custom-analysis";
import { todayIn } from "./period";

// The standing custom asks in a client's report style ("compare the $99, $89, $49 and $7 offers", "the worst creatives
// too", "conversion rate before and after the Oct 14 checkout update"), read live from the ad account for a report's
// dates when it's drafted, so the Monday weekly and the monthly recap answer them without anyone asking again.
// Meta only for now (offers and creatives come from ad names and ad-level insights).

const short = (v: unknown) => JSON.stringify(v, (_k, x) => (x === null ? undefined : x));

export async function styleAsks(rules: string[], platform: string, target: MetaTarget, period: { start: string; end: string }) {
  if (platform !== "meta" || !target?.ad_account_id) return null;
  const asks = asksInStyle(rules, todayIn());
  if (!asks.offers.length && !asks.worst && !asks.change) return null;
  const out = await customAnalysis(
    target,
    {
      since: period.start,
      until: period.end,
      offers: asks.offers,
      creatives: asks.worst ? { top: 3, worst: 3 } : null,
      change: asks.change ? { date: asks.change.date, label: asks.change.what } : null,
    },
    // The report's own last day is the newest data it may use
    new Date(Date.parse(`${period.end}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10),
  );
  const labels = [asks.offers.length ? `Offers compared (${asks.offers.map((o) => o.label).join(", ")})` : null, asks.worst ? "Top and worst creatives" : null, asks.change ? `Before and after ${asks.change.date}` : null].filter((x): x is string => Boolean(x));
  return {
    say: `This client's report style asks for ${labels.join(", ").toLowerCase()} every time, so I read them from the ad account for ${period.start} to ${period.end} and put them in.`,
    labels: labels.map((l) => `Meta · ${l} · ${period.start} to ${period.end}`),
    data: short(out).slice(0, 14_000),
  };
}
