import { requireReports } from "@/lib/auth";

// Client reports are the executives' and media buyers': everyone else goes home instead
export default async function ReportsLayout({ children }: LayoutProps<"/reports">) {
  await requireReports();
  return children;
}
