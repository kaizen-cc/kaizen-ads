import { redirect } from "next/navigation";
import { requireExec } from "@/lib/auth";

// The account review moved into KPIs (a tab of the switch, execs only): old links and bookmarks land there, on the same step

export default async function AccountReview({ searchParams }: PageProps<"/csuite">) {
  await requireExec();
  const { step, assign } = await searchParams;
  const q = new URLSearchParams({ p: "review" });
  if (typeof step === "string" && step) q.set("step", step);
  if (typeof assign === "string" && assign) q.set("assign", assign);
  redirect(`/kpis?${q.toString()}`);
}
