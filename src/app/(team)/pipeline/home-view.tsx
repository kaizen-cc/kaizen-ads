import Link from "next/link";

// Five phases instead of ten columns. Each phase groups the detailed stages the app tracks.
export const PHASES = [
  { key: "brief", name: "Brief", stages: "Requested", owner: "Requester → creative" },
  { key: "make", name: "Make", stages: "Production · revisions", owner: "Designers & editors" },
  { key: "review", name: "Review", stages: "Creative · copy", owner: "Jesus · Camille" },
  { key: "client", name: "Client", stages: "Send · approve", owner: "Jorgi · clients" },
  { key: "launch", name: "Launch", stages: "Set up · QA · live", owner: "Media buyers" },
] as const;

export type PhaseKey = (typeof PHASES)[number]["key"];

export type QueueItem = {
  id: string;
  client: string;
  title: string;
  format: "Image" | "Video" | "Carousel";
  stage: string;
  due: string;
  tone: "ok" | "warn" | "bad";
  priority?: "High" | "Urgent";
};

export type HomeData = {
  firstName: string;
  role: string;
  today: string;
  greeting: string;
  focus: { mine: number; today: number; overdue: number; clients: number };
  phases: Record<PhaseKey, number>;
  queue: QueueItem[];
  waiting: { client: string; what: string; clock: string; tone: "ok" | "warn" | "bad" }[];
  launched: { client: string; what: string; when: string }[];
  canRequest: boolean;
};

const FOCUS = [
  { key: "mine", label: "Needs you", hint: "Assigned to you", tone: "bg-brand" },
  { key: "today", label: "Due today", hint: "Business hours, ET", tone: "bg-warn" },
  { key: "overdue", label: "Overdue", hint: "Past turnaround", tone: "bg-bad" },
  { key: "clients", label: "With clients", hint: "Awaiting approval", tone: "bg-faint" },
] as const;

const DOT: Record<string, string> = { ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" };
const TXT: Record<string, string> = { ok: "text-ok", warn: "text-warn", bad: "text-bad" };

export function HomeView(d: HomeData) {
  const total = Object.values(d.phases).reduce((a, b) => a + b, 0);

  return (
    <div className="mx-auto grid max-w-6xl gap-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{d.today}</p>
          <h1 className="mt-2 font-heading text-3xl md:text-4xl">
            {d.greeting}, {d.firstName}
          </h1>
          <p className="mt-2 text-sm text-muted">
            {d.role} · {total ? `${total} pieces of creative in motion` : "Nothing in motion yet"}
          </p>
        </div>
        <button
          disabled={!d.canRequest}
          title={d.canRequest ? undefined : "Requests open in the next build phase"}
          className="group flex h-11 items-center gap-2 rounded-brand bg-brand px-5 text-sm font-medium text-white shadow-[0_8px_30px_-8px_rgba(178,30,44,0.7)] transition hover:bg-brand-hover disabled:opacity-60 disabled:shadow-none"
        >
          <span className="text-lg leading-none">+</span> New request
          {!d.canRequest && <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">Soon</span>}
        </button>
      </header>

      {/* Focus: the four numbers that decide your day */}
      <section aria-label="Focus" className="grid grid-cols-2 gap-px overflow-hidden rounded-brand border border-line bg-line lg:grid-cols-4">
        {FOCUS.map((f) => (
          <div key={f.key} className="grid gap-1 bg-surface p-5">
            <div className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${f.tone}`} />
              <p className="text-xs text-muted">{f.label}</p>
            </div>
            <p className="tabular font-heading text-4xl">{d.focus[f.key]}</p>
            <p className="text-[11px] text-faint">{f.hint}</p>
          </div>
        ))}
      </section>

      {/* Flow: where all work sits right now */}
      <section aria-label="Flow" className="grid gap-4">
        <div className="flex items-baseline justify-between">
          <h2 className="font-heading text-xl">Flow</h2>
          <span className="text-xs text-faint">All clients</span>
        </div>
        <ol className="relative grid grid-cols-5 gap-2">
          <span aria-hidden className="absolute left-[10%] right-[10%] top-[22px] h-px bg-gradient-to-r from-line via-brand/40 to-line" />
          {PHASES.map((p, i) => {
            const n = d.phases[p.key];
            return (
              <li key={p.key} className="relative grid justify-items-center gap-2 text-center">
                <span
                  className={`tabular relative grid h-11 w-11 place-items-center rounded-full border text-base font-semibold ${
                    n ? "border-brand/60 bg-brand-soft text-fg shadow-[0_0_24px_-6px_rgba(178,30,44,0.8)]" : "border-line bg-surface text-faint"
                  }`}
                >
                  {n}
                </span>
                <span className="text-sm font-medium">
                  <span className="mr-1 text-faint">{i + 1}</span>
                  {p.name}
                </span>
                <span className="hidden text-[11px] leading-tight text-faint sm:block">{p.owner}</span>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
        {/* Your queue */}
        <section aria-label="Your queue" className="grid content-start gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-xl">Your queue</h2>
            <div className="flex gap-1 rounded-full border border-line bg-surface p-1 text-xs">
              <span className="rounded-full bg-fg px-3 py-1 text-bg">Mine</span>
              <span className="px-3 py-1 text-muted">Everyone</span>
              <span className="px-3 py-1 text-muted">By client</span>
            </div>
          </div>
          {d.queue.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-brand border border-line bg-surface">
              {d.queue.map((q) => (
                <li key={q.id} className="group grid grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3.5 transition-colors hover:bg-surface-2">
                  <span className={`h-2 w-2 rounded-full ${DOT[q.tone]}`} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{q.title}</p>
                    <p className="truncate text-xs text-muted">
                      {q.client} · {q.format} · <span className="text-faint">{q.stage}</span>
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    {q.priority && (
                      <span className={`rounded-full px-2 py-0.5 text-[11px] ${q.priority === "Urgent" ? "bg-bad-soft text-bad" : "bg-warn-soft text-warn"}`}>
                        {q.priority}
                      </span>
                    )}
                    <span className={`tabular text-xs ${TXT[q.tone]}`}>{q.due}</span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid place-items-center gap-2 rounded-brand border border-dashed border-line px-6 py-16 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-xl text-faint">✓</span>
              <p className="font-heading text-lg">You&apos;re clear</p>
              <p className="max-w-sm text-sm text-muted">Anything assigned to you lines up here, most urgent first.</p>
            </div>
          )}
        </section>

        <aside className="grid content-start gap-8">
          <section className="grid gap-3">
            <h2 className="text-sm font-medium">Waiting on clients</h2>
            {d.waiting.length ? (
              <ul className="grid gap-2">
                {d.waiting.map((w) => (
                  <li key={w.client + w.what} className="flex items-center justify-between gap-3 rounded-brand border border-line bg-surface px-3 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{w.client}</span>
                      <span className="block truncate text-xs text-faint">{w.what}</span>
                    </span>
                    <span className={`tabular shrink-0 text-xs ${TXT[w.tone]}`}>{w.clock}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-faint">Nothing waiting on clients.</p>
            )}
          </section>
          <section className="grid gap-3">
            <h2 className="text-sm font-medium">Recently launched</h2>
            {d.launched.length ? (
              <ul className="grid gap-2">
                {d.launched.map((l) => (
                  <li key={l.client + l.what} className="flex items-center gap-3 text-sm">
                    <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                    <span className="min-w-0 flex-1 truncate">
                      {l.client} <span className="text-faint">· {l.what}</span>
                    </span>
                    <span className="text-xs text-faint">{l.when}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-faint">Ads pushed to Meta show here.</p>
            )}
          </section>
          <Link
            href="/clients?gaps=1"
            className="group grid gap-1 rounded-brand border border-line bg-gradient-to-br from-surface to-surface-2 p-4 transition-colors hover:border-faint"
          >
            <span className="text-sm font-medium">Get clients ready</span>
            <span className="text-xs text-muted">
              Every client needs a buyer, designer, editor and contact before requests start.{" "}
              <span className="text-brand-text transition-transform group-hover:translate-x-0.5">→</span>
            </span>
          </Link>
        </aside>
      </div>
    </div>
  );
}
