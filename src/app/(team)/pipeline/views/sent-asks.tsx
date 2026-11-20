import { createClient } from "@/lib/supabase/server";
import { loadSentAsks } from "@/lib/sent-asks";
import { SentAsksList } from "./sent-asks-list";

/**
 * Sent by you: the reminders, checklists and tasks this person's assistant (or an agent on their call) sent to
 * teammates, with the recipient's progress, tickable and commentable from here too. Under Next for me (#sent).
 */
export async function SentAsks({ me }: { me: string }) {
  const sent = await loadSentAsks(await createClient(), me).catch(() => []);
  if (!sent.length) return null;
  return <SentAsksList items={sent} />;
}
