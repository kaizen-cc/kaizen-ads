import { ChannelSoon } from "@/components/channel-soon";
import { keepCreativeOut } from "@/lib/auth";
import { lineOfTeam } from "@/lib/roles";

// The KPI board, its audits and sprints are media buying: the creative team goes to their own KPIs instead. The email
// and social teams get an empty state until their own KPIs exist (the board is never rendered for them)
export default async function KpisLayout({ children }: LayoutProps<"/kpis">) {
  const staff = await keepCreativeOut("kpis");
  const line = lineOfTeam(staff.role);
  if (line) return <ChannelSoon what="KPIs" line={line} />;
  return children;
}
