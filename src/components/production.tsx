import Link from "next/link";
import type { Production, Scorecard } from "@/lib/production";

// Creative production at a glance (execs and the Head of Creative), and each designer's, editor's and copywriter's own
// scorecard. Numbers are business days over the last 30 days, from the Asana board's history.

const d = (x: number | null) => (x == null ? "—" : `${x.toFixed(1)}d`);
const pct = (x: number | null) => (x == null ? "—" : `${x}%`);

function Tile({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="grid gap-1 rounded-[14px] border border-ink/[0.06] bg-ink/[0.03] px-4 py-3">
      <span className="text-[11px] text-ink/50">{label}</span>
      <span className={`tabular font-display text-3xl leading-none ${tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-fg"}`}>{value}</span>
      <span className="text-[11px] text-ink/40">{hint}</span>
    </div>
  );
}

const SCORE_TONE = (s: number | null) => (s == null ? "#9aa8ff" : s >= 75 ? "#5be3a5" : s >= 60 ? "#f2b14c" : "#ff4d5e");

/** The ring with the score in it. */
function Ring({ score, size = 88 }: { score: number | null; size?: number }) {
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  const color = SCORE_TONE(score);
  return (
    <span className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="var(--border)" strokeWidth="6" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="6" fill="none" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - (score ?? 0) / 100)} style={{ filter: `drop-shadow(0 0 8px ${color}66)` }} />
      </svg>
      <span className="tabular absolute font-display leading-none" style={{ color, fontSize: size * 0.32 }}>
        {score ?? "—"}
      </span>
    </span>
  );
}

/** One person's scorecard: the score, its level and trend, and the four things that make it up, each against its target. */
export function ScorecardView({ s, own = false }: { s: Scorecard; own?: boolean }) {
  const trend = s.score != null && s.previous != null ? s.score - s.previous : null;
  const what = s.kind === "copy" ? "copy" : "creative";
  return (
    <div className="relative isolate grid gap-5 overflow-hidden rounded-[22px] border border-ink/[0.07] bg-deep p-5 md:p-6">
      <span aria-hidden className="pointer-events-none absolute -left-16 -top-20 -z-10 h-56 w-56 rounded-full blur-[80px]" style={{ background: `${SCORE_TONE(s.score)}40` }} />
      <div className="flex flex-wrap items-center gap-5">
        <Ring score={s.score} />
        <div className="grid min-w-0 gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-ink/50">{own ? "Your score · last 30 days" : `${s.name} · last 30 days`}</span>
          <span className="font-display text-3xl tracking-tight" style={{ color: SCORE_TONE(s.score) }}>
            {s.level}
          </span>
          <span className="text-xs text-ink/55">
            {s.pieces} {what} {s.pieces === 1 ? "piece" : "pieces"} passed on
            {trend != null && trend !== 0 && (
              <span className={trend > 0 ? "text-ok" : "text-bad"}>
                {" "}
                · {trend > 0 ? "▲" : "▼"} {Math.abs(trend)} vs the month before
              </span>
            )}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="First pass" value={pct(s.firstPass)} hint="went through with no changes" tone={s.firstPass == null ? undefined : s.firstPass >= 70 ? "ok" : s.firstPass >= 50 ? "warn" : "bad"} />
        <Tile label="Turnaround" value={d(s.turnaround)} hint={`per piece · target ${s.turnaroundTarget}d`} tone={s.turnaround == null ? undefined : s.turnaround <= s.turnaroundTarget ? "ok" : s.turnaround <= s.turnaroundTarget * 1.5 ? "warn" : "bad"} />
        <Tile label="Revisions back" value={d(s.revisionTurnaround)} hint="to send a client revision back · target 1d" tone={s.revisionTurnaround == null ? undefined : s.revisionTurnaround <= 1 ? "ok" : s.revisionTurnaround <= 2 ? "warn" : "bad"} />
        <Tile label="Sitting" value={String(s.sitting.length)} hint="on you 2+ business days" tone={s.sitting.length ? (s.sitting.length > 2 ? "bad" : "warn") : "ok"} />
      </div>
      {s.sitting.length > 0 && (
        <div className="grid gap-1.5">
          <span className="text-[11px] text-ink/45">{own ? "Clear these to bring your score up" : "Sitting with them"}</span>
          {s.sitting.map((x) => (
            <a key={`${x.name}${x.days}`} href={x.url ?? "#"} target="_blank" rel="noreferrer" className="flex items-baseline justify-between gap-3 rounded-[10px] px-2 py-2.5 text-sm hover:bg-ink/[0.04] md:py-1">
              <span className="min-w-0 truncate">
                {x.client && <span className="text-ink/50">{x.client} · </span>}
                {x.name}
              </span>
              <span className="tabular shrink-0 text-xs text-warn">{x.days}d</span>
            </a>
          ))}
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-ink/35">
        The score weighs first pass most (40%), then turnaround against target (30%), how fast revisions go back (15%) and nothing left sitting (15%). From the Creative board in Asana.
      </p>
    </div>
  );
}

/** Production for execs and the Head of Creative: speed to a first draft, revisions and where they come from, the team. */
export function ProductionPanel({ p, showTeam }: { p: Production; showTeam: boolean }) {
  const total = p.split.copy + p.split.creative;
  const copyShare = total ? Math.round((p.split.copy / total) * 100) : null;
  return (
    <div className="grid gap-6">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="To a first draft" value={d(p.firstDraft)} hint={`brief → in front of the client · ${p.pieces} pieces`} tone={p.firstDraft == null ? undefined : p.firstDraft <= 3 ? "ok" : p.firstDraft <= 5 ? "warn" : "bad"} />
        <Tile label="Sent back by clients" value={pct(p.revisionRate)} hint="of pieces, at least once" tone={p.revisionRate == null ? undefined : p.revisionRate <= 25 ? "ok" : p.revisionRate <= 45 ? "warn" : "bad"} />
        <Tile label="Revision turnaround" value={d(p.revisionTurnaround)} hint="client revision → back to them" tone={p.revisionTurnaround == null ? undefined : p.revisionTurnaround <= 1 ? "ok" : p.revisionTurnaround <= 2 ? "warn" : "bad"} />
        <div className="grid gap-2 rounded-[14px] border border-ink/[0.06] bg-ink/[0.03] px-4 py-3">
          <span className="text-[11px] text-ink/50">Changes asked for</span>
          <span className="tabular font-display text-3xl leading-none">{total}</span>
          {total > 0 && (
            <>
              <span className="flex h-1.5 overflow-hidden rounded-full bg-ink/10">
                <span className="bg-[#9aa8ff]" style={{ width: `${copyShare}%` }} />
                <span className="bg-[#ff6b78]" style={{ width: `${100 - (copyShare ?? 0)}%` }} />
              </span>
              <span className="text-[11px] text-ink/45">
                <span className="text-[#9aa8ff]">{copyShare}% copy</span> · <span className="text-[#ff6b78]">{100 - (copyShare ?? 0)}% creative</span>
              </span>
            </>
          )}
        </div>
      </div>

      {(p.slow.length > 0 || p.revisions.length > 0) && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="grid content-start gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/45">Taking longest to a first draft</p>
            {p.slow.length ? (
              p.slow.map((c) => (
                <Link key={c.client} href={c.slug ? `/clients/${c.slug}` : "#"} className="flex items-baseline justify-between gap-3 py-1.5 text-sm hover:text-fg md:py-0">
                  <span className="min-w-0 truncate">{c.client}</span>
                  <span className="tabular shrink-0 text-xs text-warn">
                    {c.days}d avg · {c.pieces} pieces
                  </span>
                </Link>
              ))
            ) : (
              <p className="text-xs text-ok">No client is running slow.</p>
            )}
          </div>
          <div className="grid content-start gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/45">Most revisions</p>
            {p.revisions.length ? (
              p.revisions.map((c) => (
                <Link key={c.client} href={c.slug ? `/clients/${c.slug}` : "#"} className="flex items-baseline justify-between gap-3 py-1.5 text-sm hover:text-fg md:py-0">
                  <span className="min-w-0 truncate">{c.client}</span>
                  <span className="tabular shrink-0 text-xs text-warn">
                    {c.perPiece} per piece · {c.pieces} pieces
                  </span>
                </Link>
              ))
            ) : (
              <p className="text-xs text-ok">No client is sending a lot back.</p>
            )}
          </div>
        </div>
      )}

      {showTeam && p.team.length > 0 && (
        <div className="grid gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink/45">The team</p>
          {/* Phones: one card per person instead of the table */}
          <ul className="grid gap-2 md:hidden">
            {p.team.map((s) => (
              <li key={s.profileId ?? s.name} className="grid gap-2.5 rounded-[14px] border border-ink/[0.06] bg-ink/[0.03] px-4 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-sm">
                    {s.name} <span className="text-[11px] text-ink/40">{s.kind === "copy" ? "copy" : "creative"}</span>
                  </span>
                  <span className="tabular shrink-0 text-sm font-medium" style={{ color: SCORE_TONE(s.score) }}>
                    {s.score ?? "—"} <span className="text-[11px] font-normal text-ink/40">{s.level}</span>
                  </span>
                </div>
                <dl className="tabular grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  {(
                    [
                      ["Pieces", String(s.pieces)],
                      ["First pass", pct(s.firstPass)],
                      ["Turnaround", `${d(s.turnaround)} / ${s.turnaroundTarget}d`],
                      ["Revisions back", d(s.revisionTurnaround)],
                      ["Sitting", String(s.sitting.length)],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k} className="flex items-baseline justify-between gap-2">
                      <dt className="text-ink/40">{k}</dt>
                      <dd className={k === "Sitting" && s.sitting.length ? "text-warn" : "text-ink/70"}>{v}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-[11px] text-ink/40">
                  <th className="py-1.5 font-normal">Who</th>
                  <th className="py-1.5 font-normal">Score</th>
                  <th className="py-1.5 font-normal">Pieces</th>
                  <th className="py-1.5 font-normal">First pass</th>
                  <th className="py-1.5 font-normal">Turnaround</th>
                  <th className="py-1.5 font-normal">Revisions back</th>
                  <th className="py-1.5 font-normal">Sitting</th>
                </tr>
              </thead>
              <tbody>
                {p.team.map((s) => (
                  <tr key={s.profileId ?? s.name} className="border-t border-ink/[0.06]">
                    <td className="py-2">
                      {s.name} <span className="text-[11px] text-ink/40">{s.kind === "copy" ? "copy" : "creative"}</span>
                    </td>
                    <td className="tabular py-2 font-medium" style={{ color: SCORE_TONE(s.score) }}>
                      {s.score ?? "—"} <span className="text-[11px] font-normal text-ink/40">{s.level}</span>
                    </td>
                    <td className="tabular py-2 text-ink/70">{s.pieces}</td>
                    <td className="tabular py-2 text-ink/70">{pct(s.firstPass)}</td>
                    <td className="tabular py-2 text-ink/70">
                      {d(s.turnaround)} <span className="text-[11px] text-ink/35">/ {s.turnaroundTarget}d</span>
                    </td>
                    <td className="tabular py-2 text-ink/70">{d(s.revisionTurnaround)}</td>
                    <td className={`tabular py-2 ${s.sitting.length ? "text-warn" : "text-ink/40"}`}>{s.sitting.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="text-[11px] text-ink/35">Last {p.window} days, in business days, from the Creative board in Asana (every move and reassignment).</p>
    </div>
  );
}
