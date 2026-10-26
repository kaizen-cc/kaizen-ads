import type { Metadata } from "next";
import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { greetingFor } from "@/lib/dates";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { TOPICS } from "@/lib/today";
import { buildSnapshot, readSnapshot } from "@/lib/today-snapshot";
import { loadProduction } from "@/lib/production";
import { Story } from "./story";

export const metadata: Metadata = { title: "Today" };
export const maxDuration = 120;

/** The daily recap, full screen: one item at a time, most critical first, with a jump to any topic. */
export default async function TodayPage({ searchParams }: PageProps<"/today">) {
  const me = await requireStaff();
  const { topic } = await searchParams;
  const db = await createClient();
  // Designers, editors and copywriters see their own scorecard; it's worked out across the whole board (their pieces
  // can move to clients they don't hold), and only their own card is passed on
  // The review the Overview already built today (it keeps it current), so this opens at once; built here only when
  // there isn't one yet
  const [today, production] = await Promise.all([readSnapshot(db, me).then(async (s) => (s ?? (await buildSnapshot(db, me, null))).today), (me.isCreative || me.isCopywriter) && adminConfigured() ? loadProduction(createAdminClient()).catch(() => null) : Promise.resolve(null)]);
  const score = production?.team.find((s) => s.profileId === me.id) ?? null;
  // Been through today's recap: no reminder this afternoon
  if (adminConfigured()) after(async () => void (await createAdminClient().from("profiles").update({ recap_seen_on: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }) }).eq("id", me.id)));
  return (
    <Story
      firstName={me.fullName.split(" ")[0]}
      greeting={greetingFor(new Date())}
      items={today.items}
      resolved={today.resolved}
      counts={today.counts}
      topics={TOPICS}
      home={me.isExec || me.isLead ? "/pipeline" : "/next"}
      score={score}
      startTopic={typeof topic === "string" && topic in TOPICS ? (topic as keyof typeof TOPICS) : null}
    />
  );
}
