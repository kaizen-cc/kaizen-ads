import { FLOW_LABEL, type FlowType } from "@/lib/swipe/core";

// The prospect's real email flows next to its competitors' (the swipe file: captured as they arrived after the bot
// signed up, browsed and carted), in the Research view right after the market. Server-drawn; no state.

export type SwipeRow = { brand: string; role: "prospect" | "competitor"; status: string; flows: { type: FlowType; steps: number; cadence: string | null; offers: string | null }[] };

const STATUS: Record<string, string> = { new: "Signing up soon", subscribed: "Signed up, waiting for emails", active: "Emails arriving", needs_human: "Needs a human signup", silent: "Nothing sent in 14 days", retired: "Retired", paused: "Paused" };

export function SwipeBlock({ rows }: { rows: SwipeRow[] }) {
  if (!rows.length) return null;
  return (
    <section className="grid min-w-0 gap-3 rounded-[20px] border border-line bg-surface p-4 md:p-6">
      <h2 className="text-[11px] font-medium uppercase tracking-[0.16em] text-faint">Email flows (swipe file)</h2>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        {rows.map((r) => (
          <div key={r.brand} className="grid min-w-0 content-start gap-2 rounded-[14px] bg-bg p-3">
            <p className="break-words text-[14px] font-medium">
              {r.brand} <span className="text-[12px] font-normal text-faint">· {r.role === "prospect" ? "them" : "competitor (internal)"}</span>
            </p>
            {r.flows.length ? (
              <ul className="grid gap-1.5">
                {r.flows.map((f, i) => (
                  <li key={i} className="break-words text-[13px] leading-relaxed">
                    <span className="font-medium">{FLOW_LABEL[f.type] ?? f.type}</span>
                    <span className="text-muted">
                      {" "}
                      · {f.cadence ?? `${f.steps} emails`}
                      {f.offers ? ` · ${f.offers}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">{STATUS[r.status] ?? r.status}</p>
            )}
          </div>
        ))}
      </div>
      <p className="text-[12px] text-faint">Ask your assistant for the screenshots: &ldquo;show me their welcome flow next to the competitors&apos;&rdquo;.</p>
    </section>
  );
}
