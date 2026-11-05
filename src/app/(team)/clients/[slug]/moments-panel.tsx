import { Section } from "@/components/ui";
import { BriefPreviewButton } from "@/components/quick-brief-sheet";

// The client's marketing moments: the days in their year that can make a spike, each briefed its lead time ahead
// (a suggested brief on Home), then judged on its campaign. Winners come back next year and for similar businesses.

export type MomentRow = { id: string; name: string; on_date: string; lead_days: number; angle: string | null; offer_idea: string | null; status: string; suggestion_id: string | null; result: { spend?: number; ads?: number; note?: string } | null };

const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const TONE: Record<string, string> = { planned: "bg-surface-2 text-muted", briefed: "bg-brand-soft text-brand-text", ran: "bg-surface-2 text-fg", won: "bg-ok-soft text-ok", lost: "bg-bad-soft text-bad", skipped: "bg-surface-2 text-faint" };
const NAME: Record<string, string> = { planned: "Planned", briefed: "Briefed", ran: "Ran", won: "Won", lost: "Lost", skipped: "Didn't run" };

export function MomentsPanel({ moments, clientId = null }: { moments: MomentRow[]; clientId?: string | null }) {
  if (!moments.length) return null;
  const today = new Date().toISOString().slice(0, 10);
  const ahead = moments.filter((m) => m.on_date >= today);
  const past = moments.filter((m) => m.on_date < today).slice(-6).reverse();
  return (
    <Section title="Marketing moments" description="The days in their year that can make a spike. Each is briefed on Home its lead time ahead (creative, email, the promotion to ask for, the landing page), then judged on its campaign: winners come back next year and for similar businesses.">
      <div className="grid gap-2">
        {[...ahead.slice(0, 8), ...past].map((m) => (
          <div key={m.id} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-start gap-3 rounded-[14px] border border-line bg-bg/40 px-3 py-2.5 text-sm">
            <span className="tabular pt-0.5 text-[12px] text-faint">{day(m.on_date)}</span>
            <span className="grid min-w-0 gap-0.5 [overflow-wrap:anywhere]">
              <span>{m.name}</span>
              {m.angle && <span className="text-[12px] text-muted">{m.angle}</span>}
              {m.offer_idea && m.on_date >= today && <span className="text-[11px] text-faint">Ask for: {m.offer_idea}</span>}
              {m.result && (m.result.spend != null || m.result.note) && <span className="text-[11px] text-faint">{m.result.note ?? `$${m.result.spend?.toLocaleString("en-US")} across ${m.result.ads ?? 0} ads`}</span>}
              {m.status === "planned" && m.on_date >= today && <span className="text-[11px] text-faint">Briefed from {day(new Date(Date.parse(`${m.on_date}T12:00:00Z`) - m.lead_days * 86_400_000).toISOString().slice(0, 10))}</span>}
            </span>
            {m.suggestion_id && m.status === "briefed" && clientId ? (
              // Its quick preview right here; the full brief is written only when someone chooses it
              <BriefPreviewButton
                previewKey={`moment-${m.id.slice(0, 8)}`}
                clientId={clientId}
                source={{ kind: "suggestion", id: m.suggestion_id }}
                from={{ kicker: "Marketing moment", label: `${m.name} · ${day(m.on_date)}` }}
                progressLabel="brief from a summary+brief self-review"
                className={`min-h-11 rounded-full px-3 text-[11px] md:min-h-0 md:px-2.5 md:py-1 ${TONE.briefed}`}
              >
                Briefed →
              </BriefPreviewButton>
            ) : (
              <span className={`rounded-full px-2.5 py-1 text-[11px] ${TONE[m.status] ?? TONE.planned}`}>{NAME[m.status] ?? m.status}</span>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}
