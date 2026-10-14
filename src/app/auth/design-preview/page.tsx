import { notFound } from "next/navigation";
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
import { UploadProvider } from "@/components/upload-provider";
import { RequestForm } from "@/app/(team)/requests/new/request-form";
import { sampleRequest } from "./sample-request";
import { ClientView } from "@/app/(team)/clients/[slug]/client-view";
import { sampleTickets } from "./sample-tickets";

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

export default async function DesignPreview({ searchParams }: PageProps<"/auth/design-preview">) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view } = await searchParams;
  const now = new Date();
  const base = { greeting: greetingFor(now), firstName: "Santi", today: todayLabel(now) };

  let body: React.ReactNode;
  let who = { name: "Santi Lozano", role: "Executive" };

  if (view === "client" || view === "client-none") {
    body = (
      <ClientView
        client={{ id: "c1", name: "Crust Pizza Co.", slug: "crust-pizza-co", status: "active", client_type: "traditional", website: "https://crustpizza.com", meta_ad_account_id: "526528539355910", slack_channel_id: "C078D34T7FX", internal_slack_channel_id: "C06TQ0WMCJ1", drive_folder_id: "1Rnwf-WH7tz", kaizen_id: 403, auto_approve_opt_in: false, creative_package: view !== "client-none", creative_package_key: "silver", creative_package_until: "2026-11-30", creative_package_note: "Holiday push through Black Friday" }}
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
    <TeamShell name={who.name} roles={who.role}>
      {body}
    </TeamShell>
  );
}
