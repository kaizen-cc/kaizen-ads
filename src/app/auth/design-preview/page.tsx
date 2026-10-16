import { notFound } from "next/navigation";
import { AGENT_MOMENTS } from "@/lib/agent-moments";
import { TeamShell } from "@/components/team-shell";
import { PulseView } from "@/app/(team)/pipeline/views/pulse-view";
import { LeaderView } from "@/app/(team)/pipeline/views/leader-view";
import { WorkView } from "@/app/(team)/pipeline/views/work-view";
import type { PhaseKey, PhaseStat, QueueItem } from "@/app/(team)/pipeline/views/shared";
import { TeamList, type Person } from "@/app/(team)/team/team-list";
import { type ClientCard } from "@/app/(team)/clients/client-grid";
import { ClientsBrowser } from "@/app/(team)/clients/clients-browser";
import { greetingFor, todayLabel } from "@/lib/dates";
import { BoardClient } from "@/app/(team)/board/board-client";
import { Portal } from "@/app/c/[slug]/portal";
import { samplePortal } from "./sample-portal";
import { UploadProvider } from "@/components/upload-provider";
import { RequestForm } from "@/app/(team)/requests/new/request-form";
import { sampleRequest } from "./sample-request";
import { ClientView } from "@/app/(team)/clients/[slug]/client-view";
import { sampleTickets } from "./sample-tickets";
import { KpiBoard } from "@/app/(team)/kpis/kpi-board";
import { sampleKpis } from "./sample-kpis";
import type { WatchRow } from "@/lib/fatigue";
import type { OnboardingState } from "@/lib/suggestions";
import { AgentDetail, AgentsOverview, type Agent as AiAgent, type Item as AiItem } from "@/app/(team)/settings/agents";

// Local-only design check with sample data (never served in production).
// Open /auth/design-preview?view=exec | exec-empty | leader | buyer | creative | board | team | clients | client | request | request-off

const people: Person[] = [
  { id: "1", email: "santi@kaizenmarketing.agency", fullName: "Santi Lozano", role: "executive", isActive: true, joined: true, clientCount: 0 },
  { id: "2", email: "ryan@kaizenmarketing.agency", fullName: "Ryan Brand", role: "executive", isActive: true, joined: true, clientCount: 0 },
  { id: "3", email: "jesus@kaizenmarketing.agency", fullName: "Jesus", role: "head_of_creative", isActive: true, joined: false, clientCount: 4 },
  { id: "4", email: "dipesh@kaizenmarketing.agency", fullName: "Dipesh", role: "head_of_meta", isActive: true, joined: false, clientCount: 9 },
  { id: "5", email: "mark@kaizenmarketing.agency", fullName: "Mark", role: "media_buyer", isActive: true, joined: false, clientCount: 23 },
  { id: "6", email: "nelson@kaizenmarketing.agency", fullName: "Nelson", role: "graphic_designer", isActive: true, joined: false, clientCount: 36 },
  { id: "7", email: "jazem@kaizenmarketing.agency", fullName: "Jazem", role: "video_editor", isActive: true, joined: false, clientCount: 52 },
  { id: "8", email: "camille@kaizenmarketing.agency", fullName: "Camille", role: "copywriter", isActive: true, joined: false, clientCount: 0 },
  { id: "9", email: "jorgi@kaizenmarketing.agency", fullName: "Jorgi Conti", role: "customer_success", isActive: true, joined: false, clientCount: 0 },
];

const opt = (id: string, name: string) => ({ id, name });
const buyers = [opt("4", "Dipesh"), opt("5", "Mark"), opt("b2", "Priscila"), opt("b3", "Rahul")];
const designers = [opt("3", "Jesus"), opt("6", "Nelson"), opt("d2", "Hillary"), opt("d3", "Eunhye")];
const editors = [opt("3", "Jesus"), opt("7", "Jazem"), opt("e2", "Mira"), opt("e3", "Daniel")];
type SampleClient = { id: string; name: string; slug: string; whiteLabel: boolean; contacts: number; assigned: ClientCard["assigned"] };
const rows: SampleClient[] = [
  { id: "c1", name: "Crust Pizza Co.", slug: "crust-pizza-co", whiteLabel: false, contacts: 5, assigned: { meta_buyer: buyers[1], graphic_designer: designers[1], video_editor: editors[1] } },
  { id: "c2", name: "Sierra Dreams", slug: "sierra-dreams", whiteLabel: false, contacts: 2, assigned: { meta_buyer: buyers[0], graphic_designer: designers[1], video_editor: editors[1] } },
  { id: "c3", name: "Propr Dental", slug: "propr-dental", whiteLabel: true, contacts: 1, assigned: { meta_buyer: buyers[2], graphic_designer: null, video_editor: null } },
  { id: "c4", name: "Atomic Wings", slug: "atomic-wings", whiteLabel: false, contacts: 0, assigned: { meta_buyer: null, graphic_designer: null, video_editor: null } },
];

const phases: Record<PhaseKey, PhaseStat> = {
  brief: { count: 29, avgDays: 0.8, slaDays: 1 },
  make: { count: 24, avgDays: 3.6, slaDays: 3 },
  review: { count: 8, avgDays: 0.7, slaDays: 1 },
  client: { count: 42, avgDays: 2.9, slaDays: 2 },
  launch: { count: 9, avgDays: 0.6, slaDays: 1 },
};
const noPhases: Record<PhaseKey, PhaseStat> = { brief: { count: 0 }, make: { count: 0 }, review: { count: 0 }, client: { count: 0 }, launch: { count: 0 } };

const team = [
  { name: "Jazem", role: "Video editor", active: 14, overdue: 2, capacity: 10 },
  { name: "Nelson", role: "Designer", active: 9, overdue: 0, capacity: 12 },
  { name: "Hillary", role: "Designer", active: 7, overdue: 1, capacity: 10 },
  { name: "Daniel", role: "Video editor", active: 6, overdue: 1, capacity: 8 },
  { name: "Mira", role: "Video editor", active: 5, overdue: 0, capacity: 8 },
];

const buyerQueue: QueueItem[] = [
  { id: "b1", client: "Leap Funding", title: "Confirm launch · Special Category", format: "Video", stage: "Ready to launch · proposal ready", due: "1 day over", tone: "bad", priority: "Urgent" },
  { id: "b2", client: "Crust Pizza Co.", title: "QA paused ads · $8 Calzone Mondays", format: "Image", stage: "Paused in Meta", due: "Today", tone: "warn" },
  { id: "b3", client: "Best Tickets", title: "Request: Local Presence UGC", format: "Video", stage: "Brief draft", due: "Thu", tone: "ok", priority: "High" },
];

const creativeQueue: QueueItem[] = [
  { id: "c1", client: "Crust Pizza Co.", title: "Donation Program · poster v3", format: "Image", stage: "Client revision", due: "Today 6pm", tone: "warn", priority: "Urgent", note: "Make Crust & St Jude logos larger at the top" },
  { id: "c2", client: "Fast Conversational Spanish", title: "$7 trial · Unlimited Live Classes", format: "Image", stage: "In production", due: "1 day over", tone: "bad" },
  { id: "c3", client: "Sierra Dreams", title: "BFCM · Save up to 30%", format: "Image", stage: "In production", due: "Thu", tone: "ok", priority: "High" },
  { id: "c4", client: "Idalia Photography", title: "Book Lovers · discover your confidence", format: "Image", stage: "Requested", due: "Fri", tone: "ok" },
];

// Design preview only: two ads the fatigue watcher would flag
const series = (base: number, rise: number) =>
  Array.from({ length: 28 }, (_, i) => ({ d: new Date(Date.UTC(2026, 8, 18 + i)).toISOString().slice(0, 10), spend: 40 + (i % 5) * 6, ctr: 1.9 - (i > 20 ? 0.6 : 0) - i * 0.01, cpr: base * (1 + (i > 20 ? rise : rise * 0.15) + ((i * 7) % 5) * 0.03) }));
const sampleFatigue: WatchRow[] = [
  { clientId: "c1", briefId: "preview", client: "Crust Pizza Co.", clientSlug: "crust-pizza-co", adId: "1", adName: "TOF | Sep_2026 | IMG | Game Day Bundle | V2", headline: "Game day? We've got the pies.", thumbnail: null, severity: "tired", state: "open", firstFlaggedAt: "2026-10-13T12:00:00Z", requestNumbers: [],
    signals: { ctrNow: 1.12, ctrBefore: 1.86, ctrChange: -0.398, cprNow: 21.4, cprBefore: 13.9, cprChange: 0.54, accountCprChange: 0.08, freqNow: 1.9, freqBefore: 1.5, hookNow: null, hookBefore: null, hookChange: null, spend7: 412, results7: 19, result: "purchase", daysRunning: 46 }, series: series(13.9, 0.55) },
  { clientId: "c1", briefId: null, client: "Crust Pizza Co.", clientSlug: "crust-pizza-co", adId: "2", adName: "TOF | Aug_2026 | VID | Oven POV | V1", headline: "Straight from 900°", thumbnail: null, severity: "tiring", state: "open", firstFlaggedAt: "2026-10-14T12:00:00Z", requestNumbers: [],
    signals: { ctrNow: 1.41, ctrBefore: 1.62, ctrChange: -0.13, cprNow: 16.2, cprBefore: 12.8, cprChange: 0.27, accountCprChange: 0.08, freqNow: 1.6, freqBefore: 1.4, hookNow: 21.5, hookBefore: 29.8, hookChange: -0.28, spend7: 268, results7: 16, result: "purchase", daysRunning: 61 }, series: series(12.8, 0.27) },
];

// Design preview only: clients being onboarded
const sampleOnboarding: OnboardingState = {
  clients: [
    { clientId: "o1", name: "Bayou Smiles Dental", slug: "bayou-smiles-dental", since: "2026-10-13T15:00:00Z", returning: false, creative: true, industry: "Cosmetic dentistry", intake: { status: "briefed", at: "2026-10-14T14:00:00Z", business: "Family and cosmetic dentist in Baton Rouge pushing Invisalign and whitening" }, firstRound: {
      id: "s1", clientId: "o1", client: "Bayou Smiles Dental", clientSlug: "bayou-smiles-dental", kind: "onboarding", signal: "First round: which promise moves Baton Rouge parents, price or confidence", evidence: ["Intake: Invisalign is the margin driver", "Dental winners lead with a real patient's smile in the first frame"], why: "Two dental accounts get their cheapest consults from patient-first creative. This round tests that against a price-led offer so month one tells us which to scale.", version: 1, createdAt: "2026-10-14T15:00:00Z", messages: [], source: null,
      allotment: { images: 10, videos: 3, imagesUsed: 0, videosUsed: 0, until: null },
      draft: { title: "First round: smiles, offers and proof", angle: "Confidence you can see", audience: "Parents 30-50 within 15 miles of Baton Rouge", brief: Array.from({ length: 14 }, (_, i) => `Line ${i + 1} of the brief: what to show, what to say, and what to avoid.`).join("\n"), hooks: ["Your smile, straightened in months", "$0 consult this month"], landing: "https://bayousmiles.com/invisalign", sizes: ["4x5", "9x16"], formats: [{ format: "image", new: 4, variations: 2 }, { format: "video", new: 1, variations: 0 }],
        concepts: Array.from({ length: 4 }, (_, i) => ({ name: `Concept ${i + 1}`, hook: "A real patient's before and after", visual: "Close-up smile, natural light, the practice in the background.", copy: "Lead with the result, then the consult offer." })) },
    }, inProduction: [], writingSince: null, writeError: null },
    { clientId: "o2", name: "Gulf Coast Kayak Co.", slug: "gulf-coast-kayak", since: "2026-10-14T18:00:00Z", returning: false, creative: true, industry: "Kayak rentals", intake: null, firstRound: null, inProduction: [], writingSince: new Date(Date.now() - 35_000).toISOString(), writeError: null },
    { clientId: "o3", name: "Crust Pizza Co.", slug: "crust-pizza-co", since: "2026-10-10T15:00:00Z", returning: true, creative: true, industry: "Pizza restaurant", intake: { status: "briefed", at: "2026-10-11T14:00:00Z", business: "Neapolitan pizza, two locations" }, firstRound: null, inProduction: [1041, 1042], writingSince: null, writeError: null },
  ],
  unmatched: [{ id: "u1", name: "Lakeside Med Spa LLC", at: "2026-10-15T13:00:00Z" }],
};

export default async function DesignPreview({ searchParams }: PageProps<"/auth/design-preview">) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view } = await searchParams;
  const now = new Date();
  const base = { greeting: greetingFor(now), firstName: "Santi", today: todayLabel(now) };

  let body: React.ReactNode;
  let who = { name: "Santi Lozano", role: "Executive" };

  // The client portal stands on its own (no team shell)
  if (view === "portal") {
    return (
      <div className="min-h-screen">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
          <div className="mx-auto flex max-w-md items-center justify-between gap-3 px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-brand text-[11px] font-semibold text-white">CP</span>
              Crust Pizza Co. <span className="text-[10px] text-faint">▼</span>
            </span>
            <span className="rounded-full bg-surface-2 px-2.5 py-1 text-[11px] text-muted">Kaizen</span>
          </div>
        </header>
        <Portal slug="crust-pizza-co" clientName="Crust Pizza Co." firstName="Maria" data={samplePortal} testing live={false} demo />
      </div>
    );
  }

  if (view === "client" || view === "client-none") {
    body = (
      <ClientView
        client={{ id: "c1", name: "Crust Pizza Co.", slug: "crust-pizza-co", status: "active", client_type: "traditional", website: "https://crustpizza.com", meta_ad_account_id: "526528539355910", slack_channel_id: "C078D34T7FX", internal_slack_channel_id: "C06TQ0WMCJ1", drive_folder_id: "1Rnwf-WH7tz", kaizen_id: 403, auto_approve_opt_in: false, creative_package: view !== "client-none", creative_package_key: "silver", creative_package_until: "2026-11-30", creative_package_note: "Holiday push through Black Friday" }}
        fatigue={view === "client" ? sampleFatigue : []}
        intake={
          view === "client"
            ? {
                receivedAt: "2026-10-14T14:00:00Z",
                status: "briefed",
                error: null,
                summary: {
                  business: "Neapolitan pizza restaurant with two Baton Rouge locations, dine-in, takeout and catering.",
                  offer: "Game day bundles (2 pies + wings), catering for offices, and a new gluten-free crust.",
                  audience: "Families and LSU fans within 10 miles; office managers ordering lunch for teams.",
                  locations: "Baton Rouge (Perkins Rd, Bluebonnet)",
                  goals: "More online orders on game days; 20 catering orders a month by December.",
                  voice: "Warm, a little cheeky, local. Never corporate.",
                  avoid: ["Don't say 'best pizza in town'", "No discounts deeper than 20%", "Don't mention the old Highland location"],
                  proof: ["4.8 stars on Google (1,200 reviews)", "Featured in 225 Magazine 2025"],
                  competitors: ["Rotolo's", "Fat Boy's Pizza"],
                  assets: ["Professional photos from August shoot (Drive link)", "Logo files"],
                  industry: "restaurant",
                  industryDetail: "Pizza restaurant",
                  questions: ["Is the gluten-free crust available at both locations?", "Catering minimum order?"],
                },
                answers: [
                  { q: "Business name", a: "Crust Pizza Co." },
                  { q: "What makes you different?", a: "900° wood-fired oven, dough fermented 72 hours, everything made in house." },
                  { q: "Anything we should never say?", a: "Please don't call us the best pizza in town, everyone says that." },
                ],
              }
            : null
        }
        kpis={view === "client" ? sampleKpis.filter((k) => k.status === "off" || k.status === "good").slice(0, 2) : []}
        packageLabel="Silver"
        packages={[
          { key: "mvp", label: "MVP", images: 3, videos: 0 },
          { key: "basic", label: "Basic", images: 10, videos: 3 },
          { key: "silver", label: "Silver", images: 25, videos: 5 },
          { key: "gold", label: "Gold", images: 50, videos: 10 },
        ]}
        today="2026-10-14"
        team={{
          meta_buyer: { current: buyers[1], options: buyers },
          graphic_designer: { current: designers[1], options: designers },
          video_editor: { current: null, options: editors },
        }}
        contacts={[
          { id: "k1", email: "tammy@crustpizza.com", full_name: "Tammy Kravitz", auth_user_id: "x" },
          { id: "k2", email: "kim@crustpizza.com", full_name: "Kim Juda", auth_user_id: null },
        ]}
        angles={[
          { id: "a1", name: "Weekly Deals", kind: "angle", description: "Price-led offers like $8 Calzone Mondays", status: "active" },
          { id: "a2", name: "Skilled Craftsmanship", kind: "angle", description: null, status: "active" },
          { id: "a3", name: "Families nearby", kind: "avatar", description: "Parents within 10 miles", status: "active" },
        ]}
        memory={[
          { id: "m1", kind: "avoid", body: "Football Package is weekends only. Never imply it's every day.", source: "client", by: "Jorgi Conti" },
          { id: "m2", kind: "prefer", body: "Real food shots beat stock; the cheese pull always wins.", source: "team", by: "Mark" },
        ]}
        digest={{
          summary: "Tammy Kravitz is now the main approver alongside Kim Juda. Award-winning, Gift Card and Winter LTO creatives are approved; Donation Program and $8 Calzone Mondays iterations are in progress.",
          direction: "Seasonal promos on top of evergreen brand creative. Next up: Veterans Day (free 10\" pizza with Military ID), the Winter Menu/BOGA launch and St. Jude's (Nov 1 to Dec 31).",
          performance: "Price-first statics lead on cost per order ($11 vs $19 account average). The cheese-pull video still has the best CTR but frequency is 4.1 and cost is up 30% week over week, so it's tiring.",
          asks: ["Apply only the client's UTM on all Meta ads: utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}", "Veterans Day statics by Nov 4", "Larger Crust and St. Jude logos on the donation poster"],
          avoid: ["LTO items in evergreen creative", "Ads for Richmond (permanently closed)"],
          works: ["Price-first headlines", "Cheese-pull close-ups"],
          newAssets: [{ name: "Winter menu shoot / BOGA hero.jpg", url: "https://drive.google.com", note: "Hero for the Winter Menu launch" }],
          openQuestions: ["Is the mobile app launch still on hold?"],
        }}
        briefingAt="2026-10-14T16:02:00Z"
        needsInvite={[]}
        images={20}
        videos={0}
        imagesUsed={6}
        videosUsed={0}
        can={{ admin: true, contacts: true, allot: true, assign: true }}
        connections={{
          meta: { label: "Synced 5 hours ago", tone: "ok" },
          slackClient: { label: "Synced 5 hours ago", tone: "ok" },
          slackInternal: { label: "Synced 2 days ago", tone: "warn" },
          drive: { label: "Not synced yet", tone: "off" },
        }}
        demo
      />
    );
  } else if (view === "request" || view === "request-off") {
    body = (
      <div className="mx-auto max-w-5xl">
        <RequestForm
          clients={[...rows, { id: "c5", name: "Crustacean Seafood", slug: "crustacean", whiteLabel: false, contacts: 0, assigned: {} }].map((r) => ({ id: r.id, name: r.name, slug: r.slug, creative: r.id !== "c4" && r.id !== "c5" }))}
          allotments={{ c1: { images: 10, videos: 4, imagesUsed: 6, videosUsed: 1, until: null }, c2: { images: 20, videos: 6, imagesUsed: 4, videosUsed: 0, until: "2026-11-30" } }}
          anglesByClient={{ c1: ["Weekly Deals", "Fresh, never frozen", "Local favorite"] }}
          teamByClient={{ c1: { graphic_designer: "Nelson", video_editor: "Jazem", meta_buyer: "Mark" }, c2: { graphic_designer: "Nelson", meta_buyer: "Dipesh" } }}
          initialClient={null}
          aiOn={view === "request"}
          demo={sampleRequest}
        />
      </div>
    );
  } else if (view === "board") {
    const names = [...new Set(sampleTickets.map((x) => x.clientName))].sort();
    body = (
      <UploadProvider demo>
      <BoardClient
        tickets={sampleTickets}
        clients={names.map((name) => ({ id: name, name, slug: sampleTickets.find((x) => x.clientName === name)!.clientSlug }))}
        people={people.map((p) => ({ id: p.fullName, name: p.fullName, role: p.role }))}
        canRequest
        can={{ review: true, approveCopy: true }}
        demo
      />
      </UploadProvider>
    );
  } else if (view === "team") {
    body = (
      <div className="grid max-w-4xl gap-6">
        <div>
          <h1 className="font-heading text-2xl">Team</h1>
          <p className="mt-1 text-sm text-muted">One role per person. The role sets what they can see and do.</p>
        </div>
        <TeamList people={people} canEdit meId="1" />
      </div>
    );
  } else if (view === "settings" || view === "settings-agent") {
    const at = now.toISOString();
    const stats = (runs: number, avgMs: number | null) => ({ runs, avgMs, inTokens: runs * 12000, outTokens: runs * 1400, failed: 0 });
    type Sample = Omit<AiAgent, "lastAt" | "moments" | "recent"> & { recent: (Omit<AiAgent["recent"][number], "moment"> & { moment?: string | null })[] };
    const sample: Sample[] = [
      { key: "suggest", label: "Brief strategist", icon: "compass", description: "Suggests the angle, audience, hook, copy direction and format mix while someone fills in a creative request.", model: "sonnet", effort: "low", instructions: "You are Kaizen's creative strategist. A media buyer is filling in a creative request and wants a sharp starting point, fast.\n\nPriorities, in order:\n1. What the numbers say.\n2. What the client asked for recently.\n3. Client memory.\n4. The allotment.", live: true, updatedAt: at, updatedBy: "Santi Lozano", stats: stats(42, 6400), recent: [{ at, label: "suggest", model: "sonnet", ms: 5900, tokens: "12,204 in · 1,402 out", ok: true, error: null }] },
      { key: "review", label: "Request reviewer", icon: "shield", description: "Checks a finished request before it goes to the creative team: allotment, client memory, contradictions, Meta policy.", model: "opus", effort: "medium", instructions: "", live: true, updatedAt: at, updatedBy: null, stats: stats(17, 14100), recent: [] },
      { key: "briefing", label: "Client briefer", icon: "feed", description: "Reads new Slack, email, Drive and Meta data twice a day and writes each client's briefing.", model: "haiku", effort: "low", instructions: "", live: true, updatedAt: at, updatedBy: null, stats: stats(72, 3100), recent: [] },
      { key: "copy", label: "Copywriter", icon: "pen", description: "Writes primary text, headlines and on-image copy for approved briefs.", model: "sonnet", effort: "medium", instructions: "", live: false, updatedAt: at, updatedBy: null, stats: stats(0, null), recent: [] },
      { key: "launcher", label: "Launcher", icon: "rocket", description: "Turns an approved ad into campaign, ad set and ad names and settings, then pushes it to Meta paused.", model: "opus", effort: "high", instructions: "", live: false, updatedAt: at, updatedBy: null, stats: stats(0, null), recent: [] },
      { key: "fatigue", label: "Fatigue watcher", icon: "pulse", description: "Watches every ad's frequency, CTR and cost trend and flags creative that's tiring.", model: "haiku", effort: "low", instructions: "", live: false, updatedAt: at, updatedBy: null, stats: stats(0, null), recent: [] },
    ];
    // What the agents page shows from the run log: when each was last used and where it comes in
    const agents: AiAgent[] = sample.map((x) => ({
      ...x,
      recent: x.recent.map((r) => ({ ...r, moment: r.moment ?? AGENT_MOMENTS[x.key]?.[0]?.title ?? null })),
      lastAt: x.recent[0]?.at ?? (x.stats.runs ? at : null),
      moments: (AGENT_MOMENTS[x.key] ?? []).map((m, i) => ({ title: m.title, where: m.where, trigger: m.trigger, when: m.when, runs7: i === 0 ? x.stats.runs : 0, lastAt: i === 0 && x.stats.runs ? at : null })),
    }));
    const items: AiItem[] = [
      { id: "k1", agentKey: "suggest", kind: "skill", title: "Brief structure that designers can run with", body: "Write every brief in this order:\n1. Goal\n2. Audience\n3. Angle\n4. Hook\n5. Body\n6. Offer and CTA", fileName: null, active: true, updatedAt: at },
      { id: "k2", agentKey: "suggest", kind: "skill", title: "Using performance data in briefs", body: "Start from the top ads by cost per result over the last 30 days. Name the winning angle, hook and format.", fileName: null, active: true, updatedAt: at },
      { id: "k3", agentKey: "suggest", kind: "example", title: "Nectr brief that won", body: "Angle: performance claims. Hook: the can opening in slow motion.", fileName: "nectr-brief.md", active: true, updatedAt: at },
      { id: "k4", agentKey: null, kind: "knowledge", title: "How Kaizen works", body: "Kaizen Marketing is a paid social agency. ".repeat(40), fileName: null, active: true, updatedAt: at },
      { id: "k5", agentKey: null, kind: "knowledge", title: "Meta ad policy guardrails", body: "Personal attributes: never imply you know something about the viewer. ".repeat(20), fileName: null, active: true, updatedAt: at },
    ];
    body = (
      <div className="grid gap-7">
        <h1 className="font-heading text-[32px]">Settings</h1>
        {view === "settings" ? (
          <AgentsOverview agents={agents} items={items} />
        ) : (
          <AgentDetail
            a={agents[0]}
            items={items}
            chat={[
              { id: 1, role: "user", content: "The briefs feel too generic. Make them more specific.", changes: [], at },
              {
                id: 2,
                role: "coach",
                content: "I'd tighten the brief skill so every brief names the exact first frame and on-image words, and add a rule to the instructions that vague directions like 'show the product' aren't allowed.",
                changes: [
                  { op: "update_item", item_id: "k1", kind: "skill", scope: "", title: "Brief structure that designers can run with", body: "Write every brief in this order...", model: "", effort: "", reason: "Makes the hook and on-image text mandatory and concrete.", applied: true },
                  { op: "set_instructions", item_id: "", kind: "", scope: "", title: "", body: "You are Kaizen's creative strategist...", model: "", effort: "", reason: "Adds a hard rule against vague visual directions." },
                ],
                at,
              },
            ]}
          />
        )}
      </div>
    );
  } else if (view === "kpis") {
    body = (
      <KpiBoard
        rows={sampleKpis}
        buyers={[{ id: "Rahul", name: "Rahul" }, { id: "Dipesh", name: "Dipesh" }, { id: "Priscila", name: "Priscila" }, { id: "Mark", name: "Mark" }, { id: "Eduarda", name: "Eduarda" }]}
        clients={sampleKpis.map((r) => ({ id: r.clientId, name: r.client }))}
        me={{ id: "Santi", firstName: "Santi" }}
        initialOwner="all"
        lastSync={new Date(now.getTime() - 40 * 60_000).toISOString()}
      />
    );
  } else if (view === "clients") {
    body = (
      <div className="grid gap-5">
        <h1 className="font-heading text-[32px]">Clients</h1>
        <ClientsBrowser
          cards={rows.map((r, i): ClientCard => ({
            ...r,
            status: i === 3 ? "paused" : "active",
            packageLabel: ["Silver", "Gold", "Basic", null][i],
            pkg: (["ongoing", "sprint", "ongoing", "none"] as const)[i],
            until: i === 1 ? "2026-11-30" : null,
            missing: i === 2 ? 1 : 0,
            images: [{ used: 6, cap: 20 }, { used: 48, cap: 50 }, { used: 12, cap: 10 }, { used: 0, cap: 3 }][i],
            videos: [{ used: 0, cap: 0 }, { used: 7, cap: 10 }, { used: 1, cap: 3 }, { used: 0, cap: 0 }][i],
            inFlight: [4, 9, 2, 0][i],
            live: [
              { meta: "ok", slack: "ok", drive: "ok" },
              { meta: "ok", slack: "ok", drive: "warn" },
              { meta: null, slack: "ok", drive: "off" },
              { meta: null, slack: null, drive: null },
            ][i] as ClientCard["live"],
          }))}
          slotOptions={{ meta_buyer: buyers, graphic_designer: designers, video_editor: editors }}
          canEdit
        />
      </div>
    );
  } else if (view === "leader") {
    who = { name: "Jesus", role: "Head of Creative" };
    body = (
      <LeaderView
        {...base}
        firstName="Jesus"
        department="Creative"
        reviewLabel="Waiting for your review"
        stats={{ waitingOnYou: 6, teamActive: 41, teamOverdue: 3, onTimeRate: 84 }}
        review={[
          { id: "r1", client: "Fast Conversational Spanish", title: "$7 trial · teachers image", format: "Image", stage: "Uploaded by Nelson · 5h ago", due: "Due today", tone: "warn", priority: "Urgent" },
          { id: "r2", client: "Union Hill Day School", title: "October stacked", format: "Carousel", stage: "Uploaded by Hillary · 2h ago", due: "Tomorrow", tone: "ok" },
          { id: "r3", client: "Nectr", title: "Performance claim statics · v2", format: "Image", stage: "Revision from Nelson", due: "Tomorrow", tone: "ok" },
        ]}
        attention={[
          { id: "a1", tone: "bad", kind: "Stuck", client: "Tejas Brewery", title: "Seasonal tap list", detail: "In production 6 business days (turnaround 4)", owner: "Daniel" },
          { id: "a2", tone: "warn", kind: "Revisions", client: "Crust Pizza Co.", title: "Donation Program", detail: "3rd revision round · client asked for larger logos twice", owner: "Victor" },
        ]}
        team={team}
        phases={phases}
        canRequest
      />
    );
  } else if (view === "buyer" || view === "creative") {
    const buyer = view === "buyer";
    who = buyer ? { name: "Mark", role: "Media buyer" } : { name: "Nelson", role: "Graphic designer" };
    body = (
      <WorkView
        {...base}
        firstName={who.name}
        variant={buyer ? "buyer" : "creative"}
        role={who.role}
        stats={buyer ? { mine: 5, dueToday: 1, overdue: 1, fourth: 3 } : { mine: 7, dueToday: 2, overdue: 1, fourth: 2 }}
        queue={buyer ? buyerQueue : creativeQueue}
        side={
          buyer
            ? {
                title: "Waiting on your clients",
                empty: "",
                items: [
                  { label: "Leap Funding", detail: "3 videos · 2 reminders sent", value: "51h", tone: "bad" },
                  { label: "Crust Pizza Co.", detail: "5 ads", value: "6h", tone: "ok" },
                ],
              }
            : {
                title: "Coming up",
                empty: "",
                items: [
                  { label: "Sierra Dreams", detail: "BFCM · 5 images", value: "Thu", tone: "ok" },
                  { label: "Idalia Photography", detail: "Book Lovers · 2 images", value: "Fri", tone: "ok" },
                ],
              }
        }
        delivered={buyer ? undefined : { week: 11, firstPass: 73 }}
        canAct
      />
    );
  } else {
    const empty = view === "exec-empty";
    body = (
      <PulseView
        {...base}
        onboarding={view === "exec-empty" ? null : sampleOnboarding}
        clientOptions={[{ id: "c1", name: "Lakeside Med Spa" }]}
        vitals={
          empty
            ? { inMotion: 0, turnaroundDays: null, turnaroundTarget: 5, firstPassRate: null, onTimeRate: null }
            : { inMotion: 112, turnaroundDays: 6.4, turnaroundTarget: 5, firstPassRate: 58, onTimeRate: 81 }
        }
        attention={
          empty
            ? []
            : [
                { id: "e1", tone: "bad", kind: "No reply", client: "Leap Funding", title: "3 videos with the client", detail: "51 business hours, 2 reminders, no reply · Jorgi following up", owner: "Jorgi" },
                { id: "e2", tone: "bad", kind: "Revisions", client: "Crust Pizza Co.", title: "Revision-heavy this month", detail: "2.4 revision rounds per piece · logos and product shots keep coming back", owner: "Nelson · Victor" },
                { id: "e3", tone: "warn", kind: "Allotment", client: "Sierra Dreams", title: "Burning fast", detail: "48 of 60 used with 40% of the month gone · upgrade conversation?", owner: "Dipesh" },
                { id: "e4", tone: "warn", kind: "Behind", client: "OceanBox", title: "Behind on creative", detail: "4 of 13 delivered with 60% of the month gone", owner: "Jazem" },
                { id: "e5", tone: "warn", kind: "Stuck", client: "Tejas Brewery", title: "Seasonal tap list", detail: "In production 6 business days (turnaround 4)", owner: "Daniel" },
              ]
        }
        phases={empty ? noPhases : phases}
        clients={
          empty
            ? []
            : [
                { name: "Crust Pizza Co.", slug: "crust-pizza-co", tone: "bad", used: 15, allotment: 20, revisionsPerItem: 2.4, waiting: 5, note: "Unhappy with revisions" },
                { name: "Sierra Dreams", slug: "sierra-dreams", tone: "warn", used: 48, allotment: 60, revisionsPerItem: 0.6, waiting: 4, note: "Burning fast" },
                { name: "OceanBox", slug: "oceanbox", tone: "warn", used: 4, allotment: 13, revisionsPerItem: 0.8, waiting: 0, note: "Behind on creative" },
                { name: "Leap Funding", slug: "leap-funding", tone: "warn", used: 5, allotment: 13, revisionsPerItem: 1.1, waiting: 3, note: "Slow to approve" },
                { name: "Nectr", slug: "nectr", tone: "ok", used: 8, allotment: 13, revisionsPerItem: 0.4, waiting: 2, note: "On pace" },
                { name: "Limelight Entertainment", slug: "limelight-entertainment", tone: "ok", used: 36, allotment: 60, revisionsPerItem: 0.3, waiting: 0, note: "On pace" },
              ]
        }
        team={empty ? [] : team}
        monthElapsed={0.4}
      />
    );
  }

  return (
    <TeamShell name={who.name} roles={who.role} tier={who.role === "Executive" ? "exec" : who.role.startsWith("Head") ? "lead" : "member"}>
      {body}
    </TeamShell>
  );
}
