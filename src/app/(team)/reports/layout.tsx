import { ChannelSoon } from "@/components/channel-soon";
import { requireReports } from "@/lib/auth";
import { lineOfTeam } from "@/lib/roles";

// Client reports are for the executives, media buyers and the email and social teams: everyone else goes home instead.
// The email and social teams get an empty state until their own reports exist (the ad reports are never rendered for them)
export default async function ReportsLayout({ children }: LayoutProps<"/reports">) {
  const staff = await requireReports();
  const line = lineOfTeam(staff.role);
  if (line) return <ChannelSoon what="Reports" line={line} />;
  return children;
}
