import { requireExec } from "@/lib/auth";
import { loadReview, meetingTodos, openMeeting, pastMeetings } from "@/lib/csuite/load";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ReviewRunner } from "./review-runner";

// The weekly full-account review for the executives, run step by step (EOS style): Scorecard, Critical accounts, Issues
// to resolve, Upsell opportunities, Financial overview, Decisions and to-dos. The step is in the address (?step=), each
// item can be marked discuss or done or assigned to a person with a due date, and the meeting is saved as it goes.

export const metadata = { title: "Account review" };

export default async function AccountReview() {
  const me = await requireExec();
  const db = await createClient();
  const [review, meeting, past, { data: staff }] = await Promise.all([
    loadReview(db, createAdminClient()),
    openMeeting(db),
    pastMeetings(db, 6),
    db.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
  ]);
  const todos = await meetingTodos(db, meeting?.id ?? null);
  return (
    <ReviewRunner
      me={me.id}
      review={review}
      meeting={meeting}
      past={past.filter((m) => m.id !== meeting?.id).map((m) => ({ id: m.id, title: m.title, started_at: m.started_at, done: Object.values(m.items ?? {}).filter((x) => x.state === "done").length }))}
      todos={todos}
      people={(staff ?? []).map((p) => ({ id: p.id as string, name: p.full_name as string }))}
    />
  );
}
