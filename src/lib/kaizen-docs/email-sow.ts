import type { EmailSow, Lead, Table } from "@/lib/email-sow/core";
import type { Block, KDoc, KSection } from "./templates";

// An email SOW (the Email SOW Generator's content: the Sprint Recap and Ongoing Management SOW, priced from the email
// packages) as a Kaizen document, so it's drawn in the Scope of Work look as a Google Doc like every other SOW. Pure.

const bullets = (xs: Lead[]): Block[] => (xs.length ? [{ type: "bullets", items: xs.map((l) => ({ lead: l.lead, text: l.text })) }] : []);
const plain = (xs: string[]): Block[] => (xs.length ? [{ type: "bullets", items: xs.map((t) => ({ lead: "", text: t })) }] : []);
const para = (t: string): Block[] => (t ? [{ type: "paragraph", text: t }] : []);
const sub = (t: string): Block[] => (t ? [{ type: "subheading", text: t }] : []);
const box = (t: string): Block[] => (t ? [{ type: "callout", text: t }] : []);
const table = (t: Table | null): Block[] => (t ? [{ type: "table", head: t.head, rows: t.rows, total: t.total ?? null }] : []);

export function emailSowToKDoc(sow: EmailSow, preparedBy: string): KDoc {
  const sections: KSection[] = [];
  if (sow.recap) sections.push({ key: "recap", heading: sow.recap.heading, lede: "", blocks: [...sow.recap.paragraphs.flatMap(para), ...(sow.recap.stats.length ? [{ type: "stats", items: sow.recap.stats } as Block] : []), ...sub(sow.recap.built.length ? "What We Built Together" : ""), ...bullets(sow.recap.built)] });
  if (sow.numbers) {
    const n = sow.numbers;
    sections.push({ key: "numbers", heading: "The Numbers", lede: n.intro, blocks: [...sub(n.totalHeading), ...para(n.totalText), ...table(n.sources), ...sub("What Kaizen's Sends Drove"), ...para(n.sendsText), ...table(n.campaigns), ...box(n.campaignsCallout), ...sub(n.channels || n.channelsCallout ? "Performance by Channel" : ""), ...table(n.channels), ...box(n.channelsCallout)] });
  }
  if (sow.deliverability) sections.push({ key: "deliverability", heading: "Where Deliverability Stands", lede: "", blocks: [...sow.deliverability.paragraphs.flatMap(para), ...table(sow.deliverability.metrics), ...sub(sow.deliverability.levers.length ? "What Moves the Score" : ""), ...bullets(sow.deliverability.levers)] });
  const s = sow.scope;
  sections.push({
    key: "scope",
    heading: "Building on the Momentum",
    lede: s.intro,
    blocks: [
      ...sub(s.startHeading),
      ...para(s.startText),
      ...table(s.pricing),
      ...para(s.startLine),
      ...s.included.flatMap((b) => [...sub(b.heading), ...para(b.intro), ...plain(b.bullets)]),
      ...sub("Ongoing Management Tiers"),
      ...table(s.tiers),
      ...para(s.tiersNote),
      ...(s.nextTier ? [...sub(`The Path to ${s.nextTier}`), ...para(s.pathText), ...table(s.triggers), ...box(s.triggersCallout)] : []),
      ...(s.ninetyDays ? [...sub("What Success Looks Like: First 90 Days"), ...table(s.ninetyDays)] : []),
      ...(s.needs.length ? [...sub(`What Kaizen Needs From ${sow.client}`), ...bullets(s.needs)] : []),
      ...(s.outOfScope.length ? [...sub("Out of Scope"), ...plain(s.outOfScope)] : []),
      ...(s.roadmap.length ? [...sub("Future Automation Roadmap"), ...para(s.roadmapIntro), ...bullets(s.roadmap)] : []),
    ],
  });
  sections.push({ key: "closing", heading: sow.closing.heading, lede: "", blocks: [...para(sow.closing.paragraph), ...sub("Next Steps"), ...plain(sow.closing.nextSteps)] });
  return {
    template: "sow",
    title: sow.title,
    subtitle: "",
    client: sow.client,
    preparedFor: `${sow.contact}, ${sow.client}`,
    preparedBy,
    dated: sow.dated,
    kicker: `Scope of Work | ${sow.subtitle}`,
    sections,
    placeholders: sow.placeholders,
    relationshipPricing: false,
  };
}
