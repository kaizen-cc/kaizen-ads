import { keepCreativeOut } from "@/lib/auth";

// The KPI board, its audits and sprints are media buying: the creative team goes to their own KPIs instead. The email and
// social teams reach the same address and get their own board from the page (the audit and sprint pages send them back)
export default async function KpisLayout({ children }: LayoutProps<"/kpis">) {
  await keepCreativeOut("kpis");
  return children;
}
