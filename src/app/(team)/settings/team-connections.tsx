import { createAdminClient } from "@/lib/supabase/admin";
import { LABEL, NEEDS, stateText, type GapState } from "@/lib/connect-required-core";
import { roleLabel } from "@/lib/roles";

// Settings › Team (executives): who hasn't connected their own Slack and Asana yet, or is signed in to the wrong
// account or missing a scope. Everyone missing one has a critical item on their Overview and their assistant raises it
// every day; this is the list to follow up on.

const TONE: Record<GapState, string> = { ok: "bg-ok-soft text-ok", missing: "bg-bad-soft text-bad", reconnect: "bg-warn-soft text-warn", wrong: "bg-warn-soft text-warn" };

export async function TeamConnections() {
  const { teamGaps } = await import("@/lib/connect-required");
  const people = await teamGaps(createAdminClient()).catch(() => []);
  const behind = people.filter((p) => NEEDS.some((n) => p.gaps[n] !== "ok"));
  const count = (n: (typeof NEEDS)[number]) => people.filter((p) => p.gaps[n] === "ok").length;
  return (
    <section className="grid gap-3" aria-label="Who hasn't connected">
      <div className="grid gap-1">
        <h2 className="text-[16px] font-semibold text-fg">Connections</h2>
        <p className="text-[13px] leading-snug text-muted">
          Everyone connects their own Slack and Asana. {NEEDS.map((n) => `${LABEL[n]}: ${count(n)} of ${people.length}`).join(" · ")}. Anyone missing one sees it as a critical item and hears it from their assistant every day.
        </p>
      </div>
      {behind.length === 0 ? (
        <p className="rounded-[16px] border border-ok/30 bg-ok-soft/40 px-4 py-3 text-[13px] text-fg">Everyone is connected.</p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-[16px] border border-line bg-surface">
          {behind.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <span className="grid min-w-0 flex-1 gap-0.5">
                <span className="text-[14px] font-medium text-fg [overflow-wrap:anywhere]">{p.name}</span>
                <span className="text-[12px] text-faint">{roleLabel(p.role as never)}</span>
              </span>
              <span className="flex flex-wrap gap-1.5">
                {NEEDS.map((n) => (
                  <span key={n} className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${TONE[p.gaps[n]]}`}>
                    {LABEL[n]}: {stateText(p.gaps[n])}
                  </span>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
