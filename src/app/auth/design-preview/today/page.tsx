import { notFound } from "next/navigation";
import { Story } from "@/app/today/story";
import { TOPICS, type TodayItem } from "@/lib/today";

// The daily recap with sample data, for designing it without signing in. Development only.

const item = (i: Partial<TodayItem> & Pick<TodayItem, "key" | "topic" | "tier" | "title" | "client">): TodayItem => ({
  score: 50,
  clientSlug: "",
  clientId: null,
  stat: { value: "3d", label: "past what we promised" },
  story: "",
  why: "",
  evidence: [],
  action: { label: "Open the client", href: "#" },
  state: "new",
  carried: false,
  ...i,
});

const ITEMS: TodayItem[] = [
  item({ key: "p1", topic: "promises", tier: "critical", score: 91, client: "Machinery Auctioneers", stat: { value: "3", label: "business days past what we promised" }, title: "Revise buyer and seller ad copy to focus on trucks, using the client's consignment phrasing", story: 'We said this on "Machinery Auctioneers - Kaizen Media Buyers" (Oct 13). Nothing is in production for it yet.', why: "The client heard us promise it" }),
  item({ key: "o1", topic: "onboarding", tier: "critical", score: 88, client: "Good Trash", stat: { value: "2", label: "days their first round has waited on you" }, title: "Good Trash's first round is written", story: '"Reliable pickups property managers never think about". Approve it to put their first creative into production.', why: "A new client's first impression", evidence: ["Intake form in Oct 6", "Five statics planned for the launch"] }),
  item({ key: "k1", topic: "accounts", tier: "critical", score: 84, client: "Nectr", stat: { value: "35%", label: "over target per purchase" }, title: "Nectr is off target", story: "Last 7 days: $60.93 per purchase against a $45 target, on $8,240 spent.", why: "A high-priority account, off target", evidence: ["#1 problem (sheet): one UGC ad carries 25% of spend", "Spending ahead of its monthly budget"], carried: true, state: "saved" }),
  item({ key: "b1", topic: "briefs", tier: "high", score: 62, client: "Sierra Dreams", stat: { value: "8", label: "pieces in the brief" }, title: "BFCM statics: the offer, three ways", story: "Two winners are tiring a week before Black Friday; the strategist wrote the refresh.", why: "A brief waiting on a decision" }),
  item({ key: "a1", topic: "allotments", tier: "high", score: 64, client: "Best Tickets", stat: { value: "8/5", label: "videos this month" }, title: "Best Tickets is over their creative allotment", story: "8 made or in production against 5 a month, with 63% of the month gone. Hold new requests or talk about an upgrade.", why: "Making more than they pay for" }),
  item({ key: "f1", topic: "ads", tier: "normal", score: 46, client: "Crust Pizza Co.", stat: { value: "Tiring", label: "against its last three weeks" }, title: "Free garlic knots bounce-back", story: "Crust Pizza Co.'s ad is starting to slip.", why: "Early signs of wear" }),
];

export default function TodayPreview() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Story
      firstName="Santi"
      greeting="Good morning"
      items={ITEMS}
      resolved={[{ key: "r1", topic: "promises", client: "Goodmellow", title: "Evergreen local retail ads: store-entry time-lapse video", by: "Priscila", what: "put it in motion as #812" }]}
      counts={{ critical: 3, high: 2, normal: 1 }}
      topics={TOPICS}
      demo
    />
  );
}
