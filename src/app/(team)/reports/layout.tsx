import { requireReports } from "@/lib/auth";

// Client reports are for the executives, media buyers and the email and social teams: everyone else goes home instead.
// The page itself shows each person their own line (the email team email reports, the social team social reports; execs
// switch between Ads, Email and Social).
export default async function ReportsLayout({ children }: LayoutProps<"/reports">) {
  await requireReports();
  return children;
}
