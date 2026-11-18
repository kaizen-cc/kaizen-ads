import type { Staff } from "@/lib/auth";
import { loadReview, meetingTodos, openMeeting, pastMeetings } from "@/lib/csuite/load";
import { boardCounts } from "@/lib/kpi/board-counts";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { ReviewRunner } from "../csuite/review-runner";
import { kpiSwitchTabs } from "./switch-tabs";

// The weekly full-account review for the executives, a tab of the KPI switch (/kpis?p=review), run step by step (EOS
// style): Scorecard, Critical accounts, Issues to resolve, Upsell opportunities, Financial overview, Decisions and
// to-dos. The step is in the address (&step=), each item can be marked discuss or done or assigned to a person with a
// due date, and the meeting is saved as it goes.

export async function AccountReviewKpis({ me }: { me: Staff }) {
  const db = await createClient();
  const [review, meeting, past, { data: staff }, counts] = await Promise.all([
    loadReview(db, createAdminClient()),
    openMeeting(db),
    pastMeetings(db, 6),
    db.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    boardCounts(db).catch(() => null),
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
      switcher={kpiSwitchTabs(me, counts, "review")}
    />
  );
}
