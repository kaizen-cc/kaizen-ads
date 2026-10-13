import { requireStaff } from "@/lib/auth";
import { roleLabel } from "@/lib/roles";
import { greetingFor, todayLabel } from "@/lib/dates";
import { HomeView } from "./home-view";

export default async function Home() {
  const me = await requireStaff();
  const now = new Date();
  // Real counts and the queue arrive with requests in the next phase; the layout is final.
  return (
    <HomeView
      firstName={me.fullName.split(" ")[0]}
      role={roleLabel(me.role)}
      today={todayLabel(now)}
      greeting={greetingFor(now)}
      focus={{ mine: 0, today: 0, overdue: 0, clients: 0 }}
      phases={{ brief: 0, make: 0, review: 0, client: 0, launch: 0 }}
      queue={[]}
      waiting={[]}
      launched={[]}
      canRequest={false}
    />
  );
}
