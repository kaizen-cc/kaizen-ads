import { checkText, pointsLost } from "@/lib/email-score-calc";
import { emailSupport, int, money, pct, signed, socialName, socialSupport, targetSub, type EmailMetrics, type SocialMetrics } from "./core";

// A channel report's numbers as the text the writer and the QA read: every figure the report may quote, with its dates and
// what it is compared with, in one place so what the AI says and what the PDF draws can never differ.

const line = (label: string, now: string, before: string, extra = "") => `- ${label}: ${now} (before: ${before})${extra}`;

export function emailText(m: EmailMetrics): string {
  const c = m.currency;
  const { now, before } = m;
  const out: string[] = [
    `Email marketing (Klaviyo${m.account ? `, account ${m.account}` : ""}). Period: ${m.main.label} (${m.main.start} to ${m.main.end}), compared with ${m.compare.label} (${m.compare.start} to ${m.compare.end}). Revenue is what Klaviyo attributes to email through its Placed Order metric, never the store's total revenue.${now.estimated ? " The daily rows were short, so revenue is added up from the campaigns sent and the flows' own totals." : ""}`,
    line("Attributed revenue", money(now.revenue, c), money(before.revenue, c)),
    line("Campaign revenue", money(now.campaignRevenue, c), money(before.campaignRevenue, c)),
    line("Flow revenue", money(now.flowRevenue, c), money(before.flowRevenue, c)),
    ...(now.smsRevenue > 0 ? [line("SMS revenue (within the above)", money(now.smsRevenue, c), money(before.smsRevenue, c))] : []),
    line("Campaigns sent", int(now.campaignsSent), int(before.campaignsSent)),
    line("Messages sent (campaigns and flows)", int(now.sends), int(before.sends)),
    line("Open rate (email campaigns, of delivered)", pct(now.openRate), pct(before.openRate)),
    line("Click rate (email campaigns, of delivered)", pct(now.clickRate, 2), pct(before.clickRate, 2)),
    line("Unsubscribe rate", pct(now.unsubscribeRate, 2), pct(before.unsubscribeRate, 2)),
    line("Spam complaint rate", pct(now.spamRate, 3), pct(before.spamRate, 3)),
    line("Bounce rate", pct(now.bounceRate, 2), pct(before.bounceRate, 2)),
    line("Revenue per message sent", money(now.revenuePerRecipient, c), money(before.revenuePerRecipient, c)),
    ...(now.share != null ? [`- Email's share of the store's revenue: ${pct(now.share, 0)}`] : []),
    `- List: ${m.list.net != null ? `${signed(m.list.net)} net new subscribers (${int(m.list.subscribed)} joined, ${int(m.list.unsubscribed)} left)` : "no list movement read"}${m.list.profiles != null ? `; ${int(m.list.profiles)} profiles in the main list` : ""}`,
  ];
  if (m.score) {
    const sc = m.score;
    out.push(`Email health score (Kaizen's own 0 to 100 score of the account, read over the 30 days to ${sc.window.to}, not the report's own dates; green from 80, yellow from 60, red under 60): ${sc.score} of 100, ${sc.band === "good" ? "green" : sc.band === "watch" ? "yellow" : "red"}. Seven checks against healthy bars:`);
    for (const k of sc.checks) out.push(`- ${k.label}: ${k.value == null ? "nothing to measure" : checkText(k.unit, k.value, c)} against a bar of ${checkText(k.unit, k.bar, c)} (${k.value == null ? "not counted" : k.met ? "met" : `short, costing about ${pointsLost(k)} points`})`);
    out.push(sc.weighingDown.length ? `Weighing the score down, biggest first: ${sc.weighingDown.slice(0, 3).map((k) => k.label).join("; ")}.` : "Every check is at or over its bar.");
  }
  if (m.target) out.push(`- Target (${m.target.label}): ${targetSub(m.target, c) ?? "set, no progress yet"}${m.target.actual != null ? `; actual ${m.target.unit === "money" ? money(m.target.actual, c) : m.target.unit === "percent" ? pct(m.target.actual) : int(m.target.actual)}` : ""}`);
  out.push(`Campaigns sent in the period: ${m.campaignsTotal} (the best ${m.campaigns.length} by revenue)`);
  for (const k of m.campaigns) out.push(`- ${k.sendDay} ${k.channel === "sms" ? "SMS" : "email"} "${k.name}"${k.subject ? ` (subject: ${k.subject})` : ""}: ${int(k.recipients)} recipients, ${k.openRate != null ? `${pct(k.openRate)} opened, ` : ""}${pct(k.clickRate, 2)} clicked, ${money(k.revenue, c)} revenue from ${int(k.conversions)} orders${k.image ? " [has a preview picture]" : ""}`);
  out.push(`Flows (${m.flowsBasis}; revenue by flow, so these are not the period's own days):`);
  for (const f of m.flows) out.push(`- ${f.name} (${f.status ?? "status unknown"}): ${money(f.revenue, c)}, ${int(f.recipients)} recipients, ${pct(f.openRate)} opened, ${pct(f.clickRate, 2)} clicked`);
  const missing = m.keyFlows.filter((k) => k.state !== "live");
  if (missing.length) out.push(`Key flows not live: ${missing.map((k) => `${k.label} (${k.state === "missing" ? "none built" : "built, not live"})`).join("; ")}`);
  if (m.flags.length) out.push(`Deliverability flags:\n${m.flags.map((f) => `- [${f.tone === "bad" ? "red" : "amber"}] ${f.text}`).join("\n")}`);
  else out.push("Deliverability: bounce, spam and unsubscribe rates are inside healthy lines.");
  out.push(`Revenue by week (ending ${m.main.end}): ${m.trend.map((t) => `${t.label} ${money(t.value, c)}`).join(", ")}`);
  if (m.gaps.length) out.push(`Days with no data: ${m.gaps.join(", ")}`);
  out.push(`Supporting: ${emailSupport(m).map((s) => `${s.label} ${s.value}`).join("; ")}`);
  return out.join("\n");
}

export function socialText(m: SocialMetrics): string {
  const { now, before } = m;
  const out: string[] = [
    `Organic social (Facebook Page and Instagram account, read from Meta). Period: ${m.main.label} (${m.main.start} to ${m.main.end}), compared with ${m.compare.label} (${m.compare.start} to ${m.compare.end}). Engagement rate is interactions over reach.${m.insightsRead ? "" : " Meta gave no reach or interaction numbers for this account, so don't quote an engagement rate."}`,
    line("Followers (all platforms)", int(now.followers), int(before.followers)),
    line("Follower change in the period", signed(now.followerChange), signed(before.followerChange)),
    line("Reach", int(now.reach), int(before.reach)),
    line("Views", int(now.views), int(before.views)),
    line("Interactions (likes, comments, shares, saves)", int(now.interactions), int(before.interactions)),
    line("Engagement rate", m.insightsRead ? pct(now.rate) : "not available", pct(before.rate)),
    line("Profile visits", int(now.profileViews), int(before.profileViews)),
    line("Accounts engaged", int(now.engaged), int(before.engaged)),
    line("Posts published", int(now.posts), int(before.posts)),
  ];
  if (m.target) out.push(`- Target (${m.target.label}): ${targetSub(m.target) ?? "set, no progress yet"}`);
  for (const p of m.platforms) out.push(`${socialName(p.platform)}${p.name ? ` (${p.name})` : ""}: ${int(p.now.followers)} followers (${signed(p.now.followerChange)}), reach ${int(p.now.reach)} (before ${int(p.before.reach)}), views ${int(p.now.views)}, interactions ${int(p.now.interactions)}, ${p.now.rate != null ? `engagement ${pct(p.now.rate)}` : "no engagement rate"}, ${int(p.now.posts)} posts`);
  if (m.formats.length) out.push(`Posts by format: ${m.formats.map((f) => `${f.count} ${f.format}`).join(", ")}`);
  out.push(`Top posts of the period (${m.postsTotal} published, best ${m.posts.length} by engagement):`);
  for (const p of m.posts) out.push(`- ${p.postedAt?.slice(0, 10) ?? "undated"} ${socialName(p.platform)} ${p.format}${p.caption ? ` "${p.caption.slice(0, 90)}"` : ""}: ${int(p.interactions)} interactions, reach ${int(p.reach)}, views ${int(p.views)}, saves ${int(p.saves)}, shares ${int(p.shares)}, ${p.rate != null ? `${pct(p.rate)} of ${p.rateBasis === "followers" ? "followers" : "reach"}` : "no rate"}${p.thumbnail ? " [has a picture]" : ""}`);
  out.push(`Reach by week (ending ${m.main.end}): ${m.trend.map((t) => `${t.label} ${int(t.value)}`).join(", ")}`);
  if (m.gaps.length) out.push(`Days with no data: ${m.gaps.join(", ")}`);
  out.push(`Supporting: ${socialSupport(m).map((s) => `${s.label} ${s.value}`).join("; ")}`);
  return out.join("\n");
}

export const channelMetricsText = (m: EmailMetrics | SocialMetrics) => (m.platform === "klaviyo" ? emailText(m) : socialText(m));
