import { keepCreativeOut } from "@/lib/auth";

// Client reports are the buyers' and account managers': the creative team goes home instead
export default async function ReportsLayout({ children }: LayoutProps<"/reports">) {
  await keepCreativeOut("reports");
  return children;
}
