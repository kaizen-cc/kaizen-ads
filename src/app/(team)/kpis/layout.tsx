import { keepCreativeOut } from "@/lib/auth";

// The KPI board, its audits and sprints are media buying: the creative team goes to their own KPIs instead
export default async function KpisLayout({ children }: LayoutProps<"/kpis">) {
  await keepCreativeOut("kpis");
  return children;
}
