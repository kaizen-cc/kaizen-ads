import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { greetingFor } from "@/lib/dates";
import { createClient } from "@/lib/supabase/server";
import { loadToday, TOPICS } from "@/lib/today";
import { Story } from "./story";

export const metadata: Metadata = { title: "Today" };
export const maxDuration = 120;

/** The daily recap, full screen: one item at a time, most critical first, with a jump to any topic. */
export default async function TodayPage({ searchParams }: PageProps<"/today">) {
  const me = await requireStaff();
  if (!me.isExec && !me.isLead) redirect("/next");
  const { topic } = await searchParams;
  const today = await loadToday(await createClient(), me);
  return (
    <Story
      firstName={me.fullName.split(" ")[0]}
      greeting={greetingFor(new Date())}
      items={today.items}
      resolved={today.resolved}
      counts={today.counts}
      topics={TOPICS}
      startTopic={typeof topic === "string" && topic in TOPICS ? (topic as keyof typeof TOPICS) : null}
    />
  );
}
