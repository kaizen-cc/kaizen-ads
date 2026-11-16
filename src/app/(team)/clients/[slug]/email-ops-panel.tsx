import Link from "next/link";
import { activeSprints, latestAudits, loadSuggestions } from "@/lib/email-ops/load";
import { createClient } from "@/lib/supabase/server";
import { RunEmailAudit } from "../../kpis/email-ops-parts";
import { EmailOpsSuggestions } from "./email-ops-suggestions";

const BAND = { bad: { label: "Red", tone: "text-bad", ring: "border-bad/40 bg-bad-soft" }, watch: { label: "Yellow", tone: "text-warn", ring: "border-warn/40 bg-warn-soft" }, good: { label: "Green", tone: "text-ok", ring: "border-ok/40 bg-ok-soft" } } as const;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });

/** The client page's Audit and ideas tab: the latest audit and sprint, a way to run one, and the campaign ideas */
export async function EmailOpsPanel({ clientId }: { clientId: string }) {
  const db = await createClient();
  const [audits, sprints, suggestions] = await Promise.all([latestAudits(db, [clientId]), activeSprints(db, [clientId]), loadSuggestions(db, [clientId])]);
  const audit = audits.get(clientId) ?? null;
  const sprint = sprints.get(clientId) ?? null;
  const band = audit?.band ? BAND[audit.band] : null;
  return (
    <div className="grid gap-8">
      <section className="grid gap-4 rounded-[20px] border border-line bg-surface p-5 md:p-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <p className="text-xs uppercase tracking-[0.2em] text-faint">Email audit</p>
            <h2 className="font-heading text-xl leading-snug">{audit?.status === "ready" && audit.headline ? audit.headline : audit?.status === "running" ? "An audit is running" : audit?.status === "failed" ? "The last audit didn't finish" : "No audit yet"}</h2>
            <p className="text-[13px] text-muted">
              {audit
                ? `${day(audit.createdAt)}${audit.auto ? " · ran itself because the score was red" : ""}${audit.status === "ready" ? ` · ${audit.done} of ${audit.actions} moves ticked` : ""}`
                : "An audit reads the Klaviyo account against the email score and writes what to fix. It runs itself when the score goes red."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {band && audit?.status === "ready" && (
              <span className={`rounded-full border px-3 py-1 text-xs font-medium ${band.ring} ${band.tone}`}>
                {band.label} · {audit.score}
              </span>
            )}
            {audit && (
              <Link href={`/kpis/email-audit/${audit.id}`} className="grid min-h-11 place-items-center rounded-full bg-fg px-4 text-[13px] font-medium text-bg md:min-h-9">
                {audit.status === "ready" ? "Open the audit" : audit.status === "running" ? "Follow it" : "See why"}
              </Link>
            )}
            <RunEmailAudit clientId={clientId} label={audit ? "Run again" : "Run an audit"} quiet={Boolean(audit)} />
          </div>
        </div>
        {sprint && (
          <Link href={`/kpis/email-sprint/${sprint.id}`} className="flex min-h-11 flex-wrap items-center justify-between gap-2 rounded-[14px] border border-line px-4 py-3 text-[13px] hover:border-faint">
            <span>
              Sprint on: {sprint.done} of {sprint.moves} moves done
              {sprint.baseline != null && sprint.score != null ? ` · score ${sprint.baseline} to ${sprint.score}` : ""}
            </span>
            <span className="text-faint">Next check {day(sprint.nextCheckAt)} →</span>
          </Link>
        )}
      </section>
      <EmailOpsSuggestions suggestions={suggestions} clientId={clientId} />
    </div>
  );
}
