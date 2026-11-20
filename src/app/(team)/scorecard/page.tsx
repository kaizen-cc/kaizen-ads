import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { loadScorecard } from "@/lib/oversight/load";
import { isHeadRole, visibleRows, type ScoreRow } from "@/lib/oversight/core";
import { REVIEW_LINE_LABEL } from "@/lib/line-review/core";
import { roleLabel, type TeamRole } from "@/lib/roles";

export const metadata: Metadata = { title: "Weekly scorecard" };

// The weekly scorecard: per buyer or strategist, and per line head, what went wrong on their accounts (missed
// commitments, changes made without the client's sign-off, accounts silent 5+ days, accounts at retention risk) and how
// many accounts each carries. Execs see everyone; a line head their line. src/lib/oversight.

function Stat({ n, label, bad }: { n: number; label: string; bad?: boolean }) {
  return (
    <div className="grid gap-0.5">
      <span className={`tabular font-heading text-[22px] leading-none ${bad && n > 0 ? "text-bad" : n > 0 ? "text-fg" : "text-faint"}`}>{n}</span>
      <span className="text-[11px] text-muted">{label}</span>
    </div>
  );
}

function Row({ r }: { r: ScoreRow }) {
  const tone = r.score >= 12 ? "bg-bad" : r.score >= 5 ? "bg-warn" : "bg-ok";
  const t = r.team;
  return (
    <li className="relative grid gap-4 overflow-hidden rounded-[18px] border border-line bg-surface p-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,2fr)] md:items-center md:p-5">
      <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${tone}`} />
      <div className="min-w-0">
        <p className="truncate font-heading text-[18px] leading-tight">{r.name}</p>
        <p className="mt-0.5 text-[12.5px] text-muted">
          {roleLabel(r.role as TeamRole)}
          {r.line ? ` · ${REVIEW_LINE_LABEL[r.line]}` : ""}
        </p>
        {t && (
          <p className="mt-1.5 text-[12.5px] text-muted">
            Line: {t.people} people, {t.accounts} accounts, load {t.lightest}–{t.busiest} per person · {t.missed} missed, {t.unapproved} unapproved, {t.silent} silent, {t.atRisk} at risk
          </p>
        )}
      </div>
      <div className="grid grid-cols-5 gap-3">
        <Stat n={r.accounts} label="Accounts" />
        <Stat n={r.missed} label="Missed" bad />
        <Stat n={r.unapproved} label="Unapproved" bad />
        <Stat n={r.silent} label="Silent 5d+" bad />
        <Stat n={r.atRisk} label="At risk" bad />
      </div>
    </li>
  );
}

export default async function ScorecardPage() {
  const me = await requireStaff();
  if (!me.isExec && !isHeadRole(me.role)) redirect("/pipeline");
  if (!adminConfigured()) return <p className="text-sm text-muted">The scorecard can&apos;t be read here.</p>;
  const { rows } = await loadScorecard(createAdminClient());
  const shown = visibleRows(rows, me);
  const heads = shown.filter((r) => r.head);
  const people = shown.filter((r) => !r.head);
  const worst = people.filter((r) => r.score > 0).length;
  return (
    <div className="mx-auto grid max-w-5xl gap-6 md:gap-8">
      <header className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-text">Weekly scorecard</p>
        <h1 className="mt-1 font-heading text-[30px] leading-tight md:text-[34px]">{worst ? `${worst} ${worst === 1 ? "person has" : "people have"} something slipping` : "Everyone is on top of their accounts"}</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">Missed commitments, changes made without the client&apos;s sign-off, accounts with no update in 5 days, accounts at retention risk, and how many accounts each person carries. Worst first.</p>
      </header>
      {heads.length > 0 && (
        <section className="grid gap-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Heads</h2>
          <ul className="grid gap-3">
            {heads.map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </ul>
        </section>
      )}
      <section className="grid gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">Buyers and strategists</h2>
        {people.length ? (
          <ul className="grid gap-3">
            {people.map((r) => (
              <Row key={r.id} r={r} />
            ))}
          </ul>
        ) : (
          <p className="rounded-[18px] border border-dashed border-line p-6 text-sm text-muted">Nobody on this line yet.</p>
        )}
      </section>
    </div>
  );
}
