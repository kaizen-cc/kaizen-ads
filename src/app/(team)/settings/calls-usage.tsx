import Link from "next/link";
import { notFound } from "next/navigation";
import { SafetyPlayer } from "@/app/(team)/safety/[callId]/safety-player";
import { compact, dollars, groupLog, lengthLabel, PROJECTION_METHOD, sortPeople, teamLabel, TEAMS, USAGE_SORTS, workingDaysLeft, type UsagePerson, type UsageSort } from "@/lib/calls-usage-core";
import { loadCallDetail, loadCallLog, loadThreadDetail, loadUsage, ownerOnly, type CallLogEntry, type LogFilters, type OwnerWho } from "@/lib/calls-usage";
import { CallFilters } from "./calls-filters";

// Settings › Calls & usage, the owner only (checked here again, on the server, whatever the tab list showed): every
// call and chat with the agents, flagged first, and who uses the agents most and what it costs this month.

const when = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const MODE = { voice: "Voice", text: "Text", kaizen_ai: "Kaizen AI", phone: "Phone" } as const;

export async function CallsUsage({ me, sp }: { me: OwnerWho; sp: Record<string, string | string[] | undefined> }) {
  if (!ownerOnly(me)) notFound();
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const view = one("view") === "usage" ? "usage" : "logs";
  if (one("call")) return <CallView id={one("call")} back={backHref(sp)} />;
  if (one("thread")) return <ThreadView id={one("thread")} back={backHref(sp)} />;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-heading text-[20px] leading-tight">Calls &amp; usage</h2>
          <p className="mt-1 text-[13px] text-muted">Only you see this. Every call and chat with the agents, and what each person&apos;s use costs.</p>
        </div>
        <nav className="flex gap-1 rounded-full bg-surface p-1" aria-label="Calls and usage">
          {(
            [
              ["logs", "Call logs"],
              ["usage", "Usage"],
            ] as const
          ).map(([k, label]) => (
            <Link key={k} href={`/settings?tab=calls&view=${k}`} aria-current={view === k ? "page" : undefined} className={`inline-flex h-10 items-center rounded-full px-4 text-sm md:h-8 ${view === k ? "bg-fg text-bg" : "text-muted hover:text-fg"}`}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
      {view === "usage" ? <UsageView sort={(USAGE_SORTS as readonly string[]).includes(one("sort")) ? (one("sort") as UsageSort) : "cost"} /> : <LogView sp={sp} />}
    </div>
  );
}

function backHref(sp: Record<string, string | string[] | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (typeof v === "string" && k !== "call" && k !== "thread") q.set(k, v);
  q.set("tab", "calls");
  return `/settings?${q.toString()}`;
}

const nyDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const isDay = (d: unknown): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
/** The last 30 days, New York dates */
function lastMonth(): { from: string; to: string } {
  const now = Date.now();
  return { from: nyDay(new Date(now - 30 * 86_400_000)), to: nyDay(new Date(now)) };
}

async function LogView({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const range = lastMonth();
  const f: LogFilters = {
    team: typeof sp.team === "string" && TEAMS.some(([t]) => t === sp.team) ? sp.team : null,
    person: typeof sp.person === "string" ? sp.person : null,
    from: isDay(sp.from) ? sp.from : range.from,
    to: isDay(sp.to) ? sp.to : range.to,
    flag: sp.flag === "flagged" || sp.flag === "normal" ? sp.flag : null,
    q: typeof sp.q === "string" ? sp.q.slice(0, 80) : "",
  };
  const { entries, people, capped } = await loadCallLog(f);
  const groups = groupLog(entries.filter((e) => !e.logged));
  // Low flags (or only about the AI's own reliability): logged, never an alert, out of the way
  const logged = entries.filter((e) => e.logged);
  return (
    <div className="grid gap-5">
      <CallFilters
        teams={TEAMS.map(([value, label]) => ({ value, label }))}
        people={people.map((p) => ({ value: p.id, label: p.name }))}
        values={{ team: f.team ?? "", person: f.person ?? "", from: f.from, to: f.to, flag: f.flag ?? "", q: f.q }}
      />
      <p className="text-[12.5px] text-faint">
        {entries.length} {entries.length === 1 ? "conversation" : "conversations"}
        {capped ? " (the newest 800 calls; narrow the dates to see older ones)" : ""}. Unflagged calls keep their transcript only: their audio is deleted after the safety review. Flagged calls keep audio about 90 days.
      </p>
      {!groups.length && !logged.length && <p className="rounded-2xl bg-surface p-6 text-sm text-muted">Nothing matches these filters.</p>}
      {groups.map((g) => (
        <section key={String(g.flagged)} className={`grid gap-4 rounded-[22px] p-4 sm:p-5 ${g.flagged ? "border border-bad/30 bg-bad-soft/30" : "border border-line"}`}>
          <h3 className={`text-[11px] uppercase tracking-[0.16em] ${g.flagged ? "text-bad" : "text-muted"}`}>{g.flagged ? "Flagged by the safety review" : "Normal"}</h3>
          {g.teams.map((t) => (
            <div key={t.team} className="grid gap-2">
              <p className="text-[13px] font-medium text-fg">
                {t.label} <span className="text-faint">· {t.entries.length}</span>
              </p>
              <ul className="grid gap-2">
                {t.entries.map((e) => (
                  <LogRow key={`${e.kind}-${e.id}`} e={e} />
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
      {logged.length > 0 && (
        <details className="group rounded-[22px] border border-line p-4 sm:p-5">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-[11px] uppercase tracking-[0.16em] text-muted">
            <span>
              Low, logged only <span className="text-faint">· {logged.length}</span>
            </span>
            <span aria-hidden className="text-faint transition-transform group-open:rotate-180">
              ▾
            </span>
          </summary>
          <p className="mt-2 text-[12.5px] text-faint">The safety review noted these but they didn&apos;t qualify for an alert (low, not confirmed by the second check, or about the AI&apos;s own reliability).</p>
          <ul className="mt-3 grid gap-2">
            {logged.map((e) => (
              <LogRow key={`${e.kind}-${e.id}`} e={e} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function LogRow({ e }: { e: CallLogEntry }) {
  return (
    <li>
      <Link href={e.href} className="grid gap-1.5 rounded-2xl bg-surface p-3.5 transition-colors hover:bg-surface-2 active:bg-surface-2 md:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_auto] md:items-center md:gap-4 md:py-3">
        <div className="min-w-0">
          <p className="truncate text-[14px] font-medium text-fg">{e.person}</p>
          <p className="text-[12px] text-muted">
            {when(e.at)} · {lengthLabel(e.seconds)} · {MODE[e.mode]}
            {e.messages != null ? ` · ${e.messages} messages` : ""}
          </p>
        </div>
        <div className="min-w-0">
          <p className="line-clamp-2 text-[13px] text-fg">{e.topic ?? "No topic yet"}</p>
          <p className="mt-0.5 truncate text-[12px] text-muted">
            {e.agents.join(", ")}
            {e.clients.length ? ` · ${e.clients.join(", ")}` : ""}
          </p>
          {e.flagged && e.reason && <p className="mt-1 line-clamp-2 text-[12.5px] text-bad">{e.reason}</p>}
        </div>
        <div className="flex flex-wrap gap-1 md:justify-end">
          {e.severity && <span className="rounded-full bg-bad-soft px-2.5 py-0.5 text-[11.5px] text-bad">{e.severity}</span>}
          {e.categories.slice(0, 2).map((c) => (
            <span key={c} className="rounded-full bg-bg px-2.5 py-0.5 text-[11.5px] text-muted">
              {c.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      </Link>
    </li>
  );
}

async function CallView({ id, back }: { id: string; back: string }) {
  const c = await loadCallDetail(id);
  if (!c) notFound();
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-5">
      <Link href={back} className="text-[13px] text-muted hover:text-fg">
        ← Back to the call logs
      </Link>
      <section className={`rounded-[22px] p-5 sm:p-6 ${c.review?.flagged ? "border border-bad/30 bg-bad-soft/30" : "border border-line"}`}>
        <p className={`text-[11px] uppercase tracking-[0.16em] ${c.review?.flagged ? "text-bad" : "text-muted"}`}>
          {c.review?.flagged ? `Flagged by the safety review${c.review.severity ? ` · ${c.review.severity}` : ""}` : c.review ? "Reviewed · normal" : "Not reviewed yet"}
        </p>
        <h3 className="mt-1 font-heading text-[22px] leading-tight">
          {c.person} with the {c.agent}
        </h3>
        <p className="mt-1 text-sm text-muted">
          {when(c.at)} · {lengthLabel(c.seconds)} · {c.mode === "voice" ? "Voice" : "Text"}
          {c.clients.length ? ` · ${c.clients.join(", ")}` : ""}
        </p>
        {c.topic && <p className="mt-3 text-[14.5px] font-medium">{c.topic}</p>}
        {c.summary && <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{c.summary}</p>}
        {c.review?.flagged && c.review.summary && <p className="mt-3 text-[14px] leading-relaxed text-bad">{c.review.summary}</p>}
        {c.review?.flagged && (
          <Link href={`/safety/${c.id}`} className="mt-3 inline-flex h-11 items-center rounded-full border border-line px-4 text-[13px] text-fg hover:bg-surface md:h-9">
            Open the safety review (resolve, comments)
          </Link>
        )}
      </section>
      {(c.did.length > 0 || c.tasks.length > 0 || c.decisions.length > 0 || c.followUps.length > 0) && (
        <section className="grid gap-3 rounded-[22px] border border-line p-5">
          <h4 className="text-[11px] uppercase tracking-[0.16em] text-muted">What came out of it</h4>
          {c.did.map((a) => (
            <div key={a.label}>
              <p className="text-[13px] font-medium">{a.label}</p>
              <ul className="mt-1 grid gap-1 text-[13.5px] text-muted">
                {a.did.map((d, i) => (
                  <li key={i}>· {asLine(d)}</li>
                ))}
              </ul>
            </div>
          ))}
          {c.decisions.length > 0 && <List title="Decisions" items={c.decisions} />}
          {c.followUps.length > 0 && <List title="Follow-ups" items={c.followUps} />}
          {c.tasks.length > 0 && <List title="Tasks and promises it made" items={c.tasks.map((t) => `${t.title} (${t.kind}, ${t.status})`)} />}
        </section>
      )}
      {c.mode === "voice" && !c.parts.length && <p className="text-[12.5px] text-faint">{c.review?.flagged ? "The audio for this flagged call has been deleted (kept about 90 days)." : "Audio not kept for unflagged calls: the transcript is below."}</p>}
      <SafetyPlayer parts={c.parts} moments={c.review?.flagged ? c.review.moments : []} lines={c.lines} audioGone={!c.parts.length} />
    </div>
  );
}

/** A call note line as text: older calls store follow-ups as { what, due, client } objects, newer ones as plain text */
function asLine(x: unknown): string {
  if (x == null) return "";
  if (typeof x !== "object") return String(x);
  const o = x as Record<string, unknown>;
  const what = String(o.what ?? o.title ?? o.text ?? o.body ?? "").trim();
  const extra = [o.client, o.due ? `due ${o.due}` : null, o.owner ?? o.who].filter((v) => v != null && String(v).trim()).map(String);
  return [what || JSON.stringify(o), extra.length ? `(${extra.join(", ")})` : ""].filter(Boolean).join(" ");
}

function List({ title, items }: { title: string; items: readonly unknown[] }) {
  return (
    <div>
      <p className="text-[13px] font-medium">{title}</p>
      <ul className="mt-1 grid gap-1 text-[13.5px] text-muted">
        {items.map((d, i) => (
          <li key={i}>· {asLine(d)}</li>
        ))}
      </ul>
    </div>
  );
}

async function ThreadView({ id, back }: { id: string; back: string }) {
  const t = await loadThreadDetail(id);
  if (!t) notFound();
  return (
    <div className="mx-auto grid w-full max-w-3xl gap-5">
      <Link href={back} className="text-[13px] text-muted hover:text-fg">
        ← Back to the call logs
      </Link>
      <section className="rounded-[22px] border border-line p-5 sm:p-6">
        <p className="text-[11px] uppercase tracking-[0.16em] text-muted">Kaizen AI chat</p>
        <h3 className="mt-1 font-heading text-[22px] leading-tight">{t.title ?? "Untitled chat"}</h3>
        <p className="mt-1 text-sm text-muted">
          {t.person} with the {t.agent}
          {t.client ? ` · ${t.client}` : ""} · {t.messages.length} messages
        </p>
      </section>
      <ol className="grid gap-3">
        {t.messages.map((m, i) => (
          <li key={i} className={`rounded-2xl p-3.5 ${m.role === "user" ? "bg-surface" : "border border-line"}`}>
            <p className="text-[12px] text-muted">
              {m.who} · {when(m.at)}
            </p>
            <p className="mt-1 whitespace-pre-wrap break-words text-[14px] leading-relaxed">{m.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** A person's AI cost per day this month: one series, so no legend; each bar's tooltip names the day and cost */
function Trend({ daily, name }: { daily: UsagePerson["daily"]; name: string }) {
  const max = Math.max(...daily.map((d) => d.cost), 0.0001);
  const w = 4;
  const gap = 2;
  const h = 28;
  return (
    <svg viewBox={`0 0 ${daily.length * (w + gap)} ${h}`} width={daily.length * (w + gap)} height={h} role="img" aria-label={`${name}'s AI cost per day this month`} className="block max-w-full">
      <line x1="0" x2={daily.length * (w + gap)} y1={h - 0.5} y2={h - 0.5} className="stroke-line" strokeWidth="1" />
      {daily.map((d, i) => {
        const bh = d.cost > 0 ? Math.max(2, (d.cost / max) * (h - 2)) : 0;
        return (
          <g key={d.day}>
            <rect x={i * (w + gap)} y={0} width={w + gap} height={h} fill="transparent">
              <title>{`${d.day}: ${dollars(d.cost)}`}</title>
            </rect>
            {bh > 0 && (
              <rect x={i * (w + gap)} y={h - 1 - bh} width={w} height={bh} rx="1" className="fill-brand" pointerEvents="none" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

async function UsageView({ sort }: { sort: UsageSort }) {
  const u = await loadUsage();
  const people = sortPeople(u.people, sort);
  const daysLeft = workingDaysLeft(u.today);
  const head = (k: UsageSort, label: string, right = true) => (
    <th scope="col" className={`px-2 py-2 font-normal ${right ? "text-right" : "text-left"}`}>
      <Link href={`/settings?tab=calls&view=usage&sort=${k}`} aria-current={sort === k ? "true" : undefined} className={sort === k ? "text-fg" : "text-muted hover:text-fg"}>
        {label}
        {sort === k ? " ↓" : ""}
      </Link>
    </th>
  );
  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="AI cost this month" value={dollars(u.total.cost)} note={`${u.monthStart.slice(5)} to ${u.today.slice(5)}, people's own use`} />
        <Tile label="Projected by month end" value={dollars(u.total.projected)} note={`${daysLeft} working ${daysLeft === 1 ? "day" : "days"} left`} />
        <Tile label="People using the agents" value={String(u.total.people)} note="this month" />
        <Tile label="Voice" value={`${compact(u.voice.audioMinutes)} min`} note={`${compact(u.voice.characters)} characters spoken`} />
      </div>
      <p className="text-[12.5px] leading-relaxed text-faint">
        Priced like Settings › AI agents (the same model prices, cache and web searches). Projection: {PROJECTION_METHOD} Not tied to a person this month: {dollars(u.unattributed.cost)} across {compact(u.unattributed.runs)} runs, the background automation nobody started
        {u.unattributed.callOrChatRuns ? `, including ${u.unattributed.callOrChatRuns} call or chat runs from before they were attributed` : "; every call and chat run is tied to its person"}.
      </p>
      <section className="grid gap-2">
        <h3 className="text-[11px] uppercase tracking-[0.16em] text-muted">By team</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {u.teams.map((t) => (
            <div key={t.team} className="rounded-2xl bg-surface p-4">
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-[14px] font-medium">{teamLabel(t.team)}</p>
                <p className="font-heading text-[18px]">{dollars(t.cost)}</p>
              </div>
              <p className="mt-1 text-[12px] text-muted">
                {t.people} {t.people === 1 ? "person" : "people"} · {t.calls} calls · {t.chats} chats · {t.minutes} min · {compact(t.tokens)} tokens · projected {dollars(t.projected)}
              </p>
            </div>
          ))}
        </div>
      </section>
      <section className="grid gap-2">
        <h3 className="text-[11px] uppercase tracking-[0.16em] text-muted">By person</h3>
        {/* Phones: one card per person, sorted by the same link row */}
        <div className="flex flex-wrap gap-1.5 md:hidden">
          {(
            [
              ["cost", "Cost"],
              ["projected", "Projected"],
              ["calls", "Calls"],
              ["chats", "Chats"],
              ["minutes", "Minutes"],
              ["messages", "Messages"],
              ["tokens", "Tokens"],
              ["name", "Name"],
            ] as const
          ).map(([k, label]) => (
            <Link key={k} href={`/settings?tab=calls&view=usage&sort=${k}`} className={`inline-flex h-10 items-center rounded-full px-3.5 text-[13px] ${sort === k ? "bg-fg text-bg" : "bg-surface text-muted"}`}>
              {label}
            </Link>
          ))}
        </div>
        <ul className="grid gap-2 md:hidden">
          {people.map((p) => (
            <li key={p.id} className="rounded-2xl bg-surface p-4">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-[14px] font-medium">{p.name}</p>
                <p className="font-heading text-[18px]">{dollars(p.cost)}</p>
              </div>
              <p className="text-[12px] text-muted">
                {teamLabel(p.team)} · projected {dollars(p.projected)} · {p.activeDays} active {p.activeDays === 1 ? "day" : "days"}
              </p>
              <p className="mt-1 text-[12px] text-muted">
                {p.calls} calls · {p.chats} chats · {p.minutes} min · {p.messages} messages
              </p>
              <p className="text-[12px] text-muted">
                Tokens: {compact(p.input)} in · {compact(p.output)} out · {compact(p.cacheW)} cache write · {compact(p.cacheR)} cache read
              </p>
              <div className="mt-2">
                <Trend daily={p.daily} name={p.name} />
              </div>
            </li>
          ))}
        </ul>
        <div className="hidden overflow-x-auto rounded-2xl border border-line md:block">
          <table className="w-full text-[13px]">
            <thead className="border-b border-line text-[12px]">
              <tr>
                {head("name", "Person", false)}
                {head("calls", "Calls")}
                {head("chats", "Chats")}
                {head("minutes", "Min")}
                {head("messages", "Messages")}
                {head("tokens", "Tokens (in / out / cache w / r)")}
                {head("cost", "Cost")}
                {head("projected", "Projected")}
                <th scope="col" className="px-2 py-2 text-left font-normal text-muted">
                  This month
                </th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className="border-b border-line last:border-0">
                  <td className="px-2 py-2.5">
                    <p className="font-medium text-fg">{p.name}</p>
                    <p className="text-[11.5px] text-muted">{teamLabel(p.team)}</p>
                  </td>
                  <td className="px-2 text-right tabular-nums">{p.calls}</td>
                  <td className="px-2 text-right tabular-nums">{p.chats}</td>
                  <td className="px-2 text-right tabular-nums">{p.minutes}</td>
                  <td className="px-2 text-right tabular-nums">{p.messages}</td>
                  <td className="px-2 text-right tabular-nums text-muted">
                    {compact(p.input)} / {compact(p.output)} / {compact(p.cacheW)} / {compact(p.cacheR)}
                  </td>
                  <td className="px-2 text-right font-medium tabular-nums">{dollars(p.cost)}</td>
                  <td className="px-2 text-right tabular-nums text-muted" title={`${dollars(p.cost / Math.max(1, p.activeDays))} per active day × ${daysLeft} working days left`}>
                    {dollars(p.projected)}
                  </td>
                  <td className="px-2 py-2">
                    <Trend daily={p.daily} name={p.name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-2xl bg-surface p-4">
      <p className="text-[12px] text-muted">{label}</p>
      <p className="mt-1 font-heading text-[24px] leading-none">{value}</p>
      <p className="mt-1.5 text-[11.5px] text-faint">{note}</p>
    </div>
  );
}
