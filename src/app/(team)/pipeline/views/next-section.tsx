import type { Deploy } from "@/lib/google-deploy";
import type { NextForMe } from "@/lib/next-for-me";
import type { PatternsState } from "@/lib/patterns";
import { PatternsPanel } from "@/components/patterns-view";
import { NextList } from "./next-list";

/**
 * Next for me, on the Overview under the recap: everything on the signed-in person (tickets, decisions, their
 * accounts), in folding groups. The Google team also gets the Google ideas waiting on them; team members the patterns
 * that work for clients like theirs (execs and leads have those in the themes above). Linked to as /pipeline#next.
 */
export function NextSection({ data, me, deploys = [], patterns = null, canBrief = false }: { data: NextForMe; me: string; deploys?: Deploy[]; patterns?: PatternsState | null; canBrief?: boolean }) {
  const n = data.now.length + data.decide.length;
  return (
    <section id="next" aria-labelledby="next-title" className="grid scroll-mt-24 gap-6">
      <div className="grid gap-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Next for me</p>
        <h2 id="next-title" className="font-heading text-2xl tracking-tight md:text-[28px]">
          {n ? `${n} ${n === 1 ? "thing needs" : "things need"} you` : "Everything that's next for you"}
        </h2>
        <p className="text-sm text-muted">Your tickets, decisions and accounts in one place, most urgent first.</p>
      </div>
      <NextList data={data} me={me} />
      {deploys.length > 0 && (
        <div className="grid gap-3">
          <div>
            <h3 className="font-heading text-[20px] tracking-tight">Google ideas for your clients</h3>
            <p className="text-sm text-muted">Winners from other accounts, written for your clients: approve, edit or decline, then apply.</p>
          </div>
          <ul className="grid gap-2">
            {deploys.map((d) => (
              <li key={d.id}>
                <a href={`/clients/${d.clientSlug}?service=google&tab=ideas&deploy=${d.id}`} className="flex min-h-14 items-center gap-3 rounded-[16px] border border-line bg-surface px-4 py-3 transition-colors hover:border-faint">
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-[12px] text-faint">
                      {d.client} · {d.kind === "copy" ? "Ad copy" : d.kind === "campaign" ? "Campaign" : "Keywords"}
                    </span>
                    <span className="truncate text-[14px]">{d.plan?.summary ?? "From a Google winner"}</span>
                  </span>
                  <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] ${d.status === "open" ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"}`}>{d.status === "open" ? "To decide" : "To apply"}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {patterns && patterns.groups.length > 0 && (
        <div className="grid gap-3">
          <div>
            <h3 className="font-heading text-[20px] tracking-tight">What works for clients like yours</h3>
            <p className="text-sm text-muted">Proven across several of our clients in the same kind of business. The refresh briefs and audits for your accounts build on these.</p>
          </div>
          <PatternsPanel state={patterns} canBrief={canBrief} canRefresh={false} />
        </div>
      )}
    </section>
  );
}
