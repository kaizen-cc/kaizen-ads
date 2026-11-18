import { checkText, pointsLost } from "@/lib/email-score-calc";
import { emailSupport, int, money, pct, signed, socialName, socialSupport, targetSub, type EmailMetrics, type SocialMetrics } from "./core";
import { grade, RATE_BARS, type MessageRow, type Pair } from "./email-detail";
import { periodWords, socialHappenedBullets, whatHappenedBullets } from "./email-message";
import { locationText } from "@/lib/klaviyo/locations";
import { channelMtdText } from "./mtd";

// A channel report's numbers as the text the writer and the QA read: every figure the report may quote, with its dates and
// what it is compared with, in one place so what the AI says and what the PDF draws can never differ.

const line = (label: string, now: string, before: string, extra = "") => `- ${label}: ${now} (before: ${before})${extra}`;

export function emailText(m: EmailMetrics): string {
  const c = m.currency;
  const { now, before } = m;
  const out: string[] = [
    `Email marketing (${m.source ?? "Klaviyo"}${m.account ? `, account ${m.account}` : ""}). Period: ${m.main.label} (${m.main.start} to ${m.main.end}), compared with ${m.compare.label} (${m.compare.start} to ${m.compare.end}). ${m.revenueMeasured === false ? `${m.source ?? "This source"} reports no revenue for this client: never quote revenue, orders or order rates, and leave them out.` : m.source ? `Revenue is what ${m.source} reports for email and SMS, never the store's total revenue.` : "Revenue is what Klaviyo attributes to email through its Placed Order metric, never the store's total revenue."}${now.estimated ? " The daily rows were short, so revenue is added up from the campaigns sent and the flows' own totals." : ""}`,
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
  out.push(...channelMtdText(m));
  if (m.score) {
    const sc = m.score;
    out.push(`Email health score (Kaizen's own 0 to 100 score of the account, read over the 30 days to ${sc.window.to}, not the report's own dates; green from 80, yellow from 60, red under 60): ${sc.score} of 100, ${sc.band === "good" ? "green" : sc.band === "watch" ? "yellow" : "red"}. Seven checks against healthy bars:`);
    for (const k of sc.checks) out.push(`- ${k.label}: ${k.value == null ? "nothing to measure" : checkText(k.unit, k.value, c, k.bar)} against a bar of ${checkText(k.unit, k.bar, c)} (${k.value == null ? "not counted" : k.met ? "met" : `short, costing about ${pointsLost(k)} points`})`);
    out.push(sc.weighingDown.length ? `Weighing the score down, biggest first: ${sc.weighingDown.slice(0, 3).map((k) => k.label).join("; ")}.` : "Every check is at or over its bar.");
  }
  if (m.target) out.push(`- Target (${m.target.label}): ${targetSub(m.target, c) ?? "set, no progress yet"}${m.target.actual != null ? `; actual ${m.target.unit === "money" ? money(m.target.actual, c) : m.target.unit === "percent" ? pct(m.target.actual) : int(m.target.actual)}` : ""}`);
  if (m.byMetric?.length) {
    out.push(`Each metric that counts as the sale, side by side (primary first; the revenue above is the primary's):`);
    for (const x of m.byMetric) out.push(line(`${x.name}: attributed revenue`, money(x.revenue.now, c), money(x.revenue.before, c), `; conversions ${int(x.conversions.now)} (before: ${int(x.conversions.before)})${x.store.now != null ? `; the store's own total ${money(x.store.now, c)}` : ""}`));
  }
  const locations = m.locations ? locationText(m.locations, c) : null;
  if (m.detail) {
    out.push(detailText(m));
    if (locations) out.push(locations);
    return out.join("\n");
  }
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
  if (locations) out.push(locations);
  return out.join("\n");
}

const was = (p: Pair, f: (x: number | null) => string) => `${f(p.now)} (before: ${f(p.before)})`;
const row = (r: MessageRow, c: string | null) => `${int(r.recipients)} recipients, ${r.openRate != null ? `${pct(r.openRate)} opened, ` : ""}${pct(r.clickRate, 2)} clicked, ${int(r.orders)} orders (${pct(r.orderRate, 2)} of recipients ordered), ${money(r.revenue, c)} revenue${r.orders ? `, average order ${money(r.revenue / r.orders, c)}` : ""}`;

/** The detail the PDF draws, as the writer reads it: every campaign and the flows for the report's own dates, and what's coming up */
function detailText(m: EmailMetrics): string {
  const d = m.detail!;
  const c = m.currency;
  const out: string[] = [
    `The message's What happened bullets, exactly (period ${periodWords(m.main)}):`,
    ...whatHappenedBullets(m).map((b) => `- ${b}`),
    `- Orders before: ${int(d.orders.before)}`,
    `Campaign performance (${d.campaign.sent.now ?? 0} sent; before: ${d.campaign.sent.before ?? 0}): recipients ${was(d.campaign.recipients, int)}; open rate ${was(d.campaign.open, (x) => pct(x))} (${grade(d.campaign.open.now, RATE_BARS.campaign.open) ?? "n/a"} against Kaizen's ${pct(RATE_BARS.campaign.open, 0)} bar); click rate ${was(d.campaign.click, (x) => pct(x, 2))} (${grade(d.campaign.click.now, RATE_BARS.campaign.click) ?? "n/a"} against ${pct(RATE_BARS.campaign.click, 0)}); placed order rate ${was(d.campaign.orderRate, (x) => pct(x, 2))}.`,
    `Every campaign sent in the period, by date:`,
    ...d.campaigns.map((r) => `- ${r.date} ${r.channel === "sms" ? "SMS" : "email"} "${r.name}": ${row(r, c)}`),
  ];
  if (d.flow) {
    out.push(`Automated emails (flows) for the period's own dates (call them automated emails in the client's message, never flows): ${d.flow.sent.now ?? 0} sent; recipients ${was(d.flow.recipients, int)}; open rate ${was(d.flow.open, (x) => pct(x))} (${grade(d.flow.open.now, RATE_BARS.flow.open) ?? "n/a"} against ${pct(RATE_BARS.flow.open, 0)}); click rate ${was(d.flow.click, (x) => pct(x, 2))} (${grade(d.flow.click.now, RATE_BARS.flow.click) ?? "n/a"} against ${pct(RATE_BARS.flow.click, 1)}); placed order rate ${was(d.flow.orderRate, (x) => pct(x, 2))}; revenue ${was(d.flow.revenue, (x) => money(x, c))}.`);
    out.push(`Each automated email that sent, best revenue first:`);
    for (const r of d.flows) out.push(`- "${r.name}" (${r.status ?? "status unknown"}): ${row(r, c)}`);
    if (d.flowsOther) out.push(`- ${d.flowsOther.name} together: ${row(d.flowsOther, c)}`);
  } else {
    out.push(`Automated emails (${m.flowsBasis}; not the period's own days, so say "over the last 30 days" if you quote one):`);
    for (const f of m.flows) out.push(`- "${f.name}" (${f.status ?? "status unknown"}): ${money(f.revenue, c)}, ${int(f.recipients)} recipients, ${pct(f.openRate)} opened, ${pct(f.clickRate, 2)} clicked`);
  }
  if (d.deliverability) {
    const v = d.deliverability;
    out.push(`Deliverability (campaign email): bounce ${was(v.bounce, (x) => pct(x, 2))}, spam complaints ${was(v.spam, (x) => pct(x, 3))}, unsubscribes ${was(v.unsub, (x) => pct(x, 2))}; Kaizen's deliverability score ${v.score.now ?? "n/a"} of 100 (before: ${v.score.before ?? "n/a"}).`);
  }
  if (m.flags.length) out.push(`Deliverability flags:\n${m.flags.map((f) => `- [${f.tone === "bad" ? "red" : "amber"}] ${f.text}`).join("\n")}`);
  if (d.subscribers) {
    const sb = d.subscribers;
    out.push(`Subscribers (main email list): ${sb.total.now != null ? `${int(sb.total.now)} at the end of the period (before: ${int(sb.total.before)}); ` : ""}new subscribers ${was(sb.joined, int)}; unsubscribed ${was(sb.left, int)}.`);
  }
  const missing = m.keyFlows.filter((k) => k.state !== "live");
  if (missing.length) out.push(`Key automated emails not live: ${missing.map((k) => `${k.label} (${k.state === "missing" ? "none built" : "built, not live"})`).join("; ")}`);
  const up = m.upcoming ?? [];
  out.push(
    up.length
      ? `Coming up (dated, from the client's Klaviyo schedule and the team's campaign plan; "idea" means suggested, not confirmed: only list an idea if the work log or what was said confirms it):\n${up.map((u) => `- ${u.date}: ${u.title} [${u.source === "klaviyo" ? "scheduled in Klaviyo" : u.source === "planned" ? "planned by the team" : "idea"}]`).join("\n")}`
      : "Coming up: nothing dated is scheduled or planned; take Coming up only from the work log and what was said, never invent it.",
  );
  if (m.gaps.length) out.push(`Days with no data: ${m.gaps.join(", ")}`);
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
    `The message's What happened bullets, exactly (period ${periodWords(m.main)}):`,
    ...socialHappenedBullets(m).map((x) => `- ${x}`),
  ];
  out.push(...channelMtdText(m));
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
