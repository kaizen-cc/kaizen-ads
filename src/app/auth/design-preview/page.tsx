import { notFound } from "next/navigation";
import { TeamShell } from "@/components/team-shell";
import { HomeView } from "@/app/(team)/pipeline/home-view";
import { TeamList, type Person } from "@/app/(team)/team/team-list";
import { ClientsTable, type ClientRow } from "@/app/(team)/clients/clients-table";
import { greetingFor, todayLabel } from "@/lib/dates";

// Local-only design check with sample data (never served in production).
// Open /auth/design-preview?view=home | home-empty | team | clients

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
const rows: ClientRow[] = [
  { id: "c1", name: "Crust Pizza Co.", slug: "crust-pizza-co", whiteLabel: false, contacts: 5, assigned: { meta_buyer: buyers[1], graphic_designer: designers[1], video_editor: editors[1] } },
  { id: "c2", name: "Sierra Dreams", slug: "sierra-dreams", whiteLabel: false, contacts: 2, assigned: { meta_buyer: buyers[0], graphic_designer: designers[1], video_editor: editors[1] } },
  { id: "c3", name: "Propr Dental", slug: "propr-dental", whiteLabel: true, contacts: 1, assigned: { meta_buyer: buyers[2], graphic_designer: null, video_editor: null } },
  { id: "c4", name: "Atomic Wings", slug: "atomic-wings", whiteLabel: false, contacts: 0, assigned: { meta_buyer: null, graphic_designer: null, video_editor: null } },
];

export default async function DesignPreview({ searchParams }: PageProps<"/auth/design-preview">) {
  if (process.env.NODE_ENV === "production") notFound();
  const { view } = await searchParams;
  const now = new Date();

  let body: React.ReactNode;
  if (view === "team") {
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
        <h1 className="font-heading text-2xl">Clients</h1>
        <ClientsTable rows={rows} slotOptions={{ meta_buyer: buyers, graphic_designer: designers, video_editor: editors }} canEdit emptyText="No clients match." />
      </div>
    );
  } else {
    const empty = view === "home-empty";
    body = (
      <HomeView
        firstName="Santi"
        role="Executive"
        today={todayLabel(now)}
        greeting={greetingFor(now)}
        focus={empty ? { mine: 0, today: 0, overdue: 0, clients: 0 } : { mine: 7, today: 3, overdue: 2, clients: 37 }}
        phases={empty ? { brief: 0, make: 0, review: 0, client: 0, launch: 0 } : { brief: 29, make: 24, review: 8, client: 42, launch: 9 }}
        queue={
          empty
            ? []
            : [
                { id: "q1", client: "Leap Funding", title: "Special Category · instant form", format: "Video", stage: "With client · 51h", due: "2 days over", tone: "bad", priority: "Urgent" },
                { id: "q2", client: "Tejas Brewery", title: "Seasonal tap list", format: "Video", stage: "In production", due: "1 day over", tone: "bad", priority: "Urgent" },
                { id: "q3", client: "Crust Pizza Co.", title: "$8 Calzone Mondays", format: "Image", stage: "Copy review", due: "Today 6pm", tone: "warn" },
                { id: "q4", client: "Sierra Dreams", title: "BFCM · Buy More, Save More", format: "Image", stage: "Requested", due: "Thu", tone: "ok", priority: "High" },
                { id: "q5", client: "Nectr", title: "Energy Anywhere hook iteration", format: "Video", stage: "In production", due: "Fri", tone: "ok" },
              ]
        }
        waiting={empty ? [] : [
          { client: "Leap Funding", what: "3 videos", clock: "51h", tone: "bad" },
          { client: "Sierra Dreams", what: "4 images", clock: "28h", tone: "warn" },
          { client: "Crust Pizza Co.", what: "5 ads", clock: "6h", tone: "ok" },
        ]}
        launched={empty ? [] : [
          { client: "Darling Psychology", what: "Profile visits carousel", when: "Today" },
          { client: "Limelight", what: "Photo + Video + DJ", when: "Mon" },
        ]}
        canRequest={!empty}
      />
    );
  }

  return (
    <TeamShell name="Santi Lozano" roles="Executive">
      {body}
    </TeamShell>
  );
}
