import { createClient } from "@/lib/supabase/server";
import { loadNudges } from "@/lib/escalation-ladder";
import { NudgeList } from "./nudge-list";

/**
 * The escalation ladder on a lead's Overview: a teammate's item that sat 48 hours with nothing done, as a Slack message
 * drafted to nudge them (sent as the lead, from their Slack). Never the work itself. Nothing when there's none.
 */
export async function NudgeCallout({ me }: { me: string }) {
  const nudges = await loadNudges(await createClient(), me).catch(() => []);
  if (!nudges.length) return null;
  return <NudgeList nudges={nudges} />;
}
