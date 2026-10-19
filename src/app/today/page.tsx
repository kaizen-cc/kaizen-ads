import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";
import { greetingFor } from "@/lib/dates";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadToday, TOPICS } from "@/lib/today";
import { Story } from "./story";

export const metadata: Metadata = { title: "Today" };
export const maxDuration = 120;

/** The daily recap, full screen: one item at a time, most critical first, with a jump to any topic. */
export default async function TodayPage({ searchParams }: PageProps<"/today">) {
  const me = await requireStaff();
  const { topic } = await searchParams;
  const db = await createClient();
  const today = await loadToday(db, me);
  // Been through today's recap: no reminder this afternoon
  if (adminConfigured()) await createAdminClient().from("profiles").update({ recap_seen_on: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }) }).eq("id", me.id);
  return (
    <Story
      firstName={me.fullName.split(" ")[0]}
      greeting={greetingFor(new Date())}
      items={today.items}
      resolved={today.resolved}
      counts={today.counts}
      topics={TOPICS}
      home={me.isExec || me.isLead ? "/pipeline" : "/next"}
      startTopic={typeof topic === "string" && topic in TOPICS ? (topic as keyof typeof TOPICS) : null}
    />
  );
}
