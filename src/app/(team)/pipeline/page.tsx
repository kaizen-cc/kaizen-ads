import { requireStaff, type Staff } from "@/lib/auth";
import { greetingFor, todayLabel } from "@/lib/dates";
import { roleLabel } from "@/lib/roles";
import { LeaderView } from "./views/leader-view";
import { PulseView } from "./views/pulse-view";
import type { PhaseKey, PhaseStat } from "./views/shared";
import { WorkView, type WorkVariant } from "./views/work-view";

const noPhases = (): Record<PhaseKey, PhaseStat> => ({
  brief: { count: 0 },
  make: { count: 0 },
  review: { count: 0 },
  client: { count: 0 },
  launch: { count: 0 },
});

const variantFor = (me: Staff): WorkVariant =>
  me.isCreative ? "creative" : me.isCopywriter ? "copy" : me.isCoordinator ? "cs" : "buyer";

const department = (me: Staff) => (me.role === "head_of_creative" ? "Creative" : me.role === "head_of_google" ? "Google" : "Meta");

// Each tier gets its own home. Real numbers arrive with requests in the next phase; the layouts are final.
export default async function Home() {
  const me = await requireStaff();
  const now = new Date();
  const base = { greeting: greetingFor(now), firstName: me.fullName.split(" ")[0], today: todayLabel(now) };

  if (me.isExec) {
    return (
      <PulseView
        {...base}
        vitals={{ inMotion: 0, turnaroundDays: null, turnaroundTarget: 5, firstPassRate: null, onTimeRate: null }}
        attention={[]}
        phases={noPhases()}
        clients={[]}
        team={[]}
        monthElapsed={now.getDate() / new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}
      />
    );
  }

  if (me.isLead) {
    const dept = department(me);
    return (
      <LeaderView
        {...base}
        department={dept}
        reviewLabel={dept === "Creative" ? "Waiting for your review" : "Ready to launch"}
        stats={{ waitingOnYou: 0, teamActive: 0, teamOverdue: 0, onTimeRate: null }}
        review={[]}
        attention={[]}
        team={[]}
        phases={noPhases()}
        canRequest
      />
    );
  }

  const variant = variantFor(me);
  return (
    <WorkView
      {...base}
      variant={variant}
      role={roleLabel(me.role)}
      stats={{ mine: 0, dueToday: 0, overdue: 0, fourth: 0 }}
      queue={[]}
      side={
        variant === "buyer"
          ? { title: "Waiting on your clients", items: [], empty: "Approvals your clients owe show here." }
          : variant === "creative"
            ? { title: "Coming up", items: [], empty: "Briefs assigned to you appear here before they're due." }
            : variant === "copy"
              ? { title: "Recently passed on", items: [], empty: "Copy you've approved this week." }
              : { title: "Waiting on clients", items: [], empty: "Approvals in progress, with their business-hours clock." }
      }
      delivered={variant === "creative" ? { week: 0, firstPass: null } : undefined}
      canAct={variant === "buyer"}
    />
  );
}
