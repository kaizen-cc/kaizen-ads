import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import type { ChatTurn, ComebackDoc, HandoffDoc } from "@/lib/handoff";
import { createClient } from "@/lib/supabase/server";
import { AccountChat, HandoffBar, Seen, Writing } from "./handoff-parts";

export const metadata: Metadata = { title: "Account handoff", robots: { index: false, follow: false } };
export const maxDuration = 300;

/**
 * A new media buyer's handoff for an account: everything about the client up to now, laid out to read here or save
 * as a PDF, with a chat beside it to ask the system anything the handoff doesn't answer.
 */
export default async function HandoffPage({ params }: PageProps<"/handoff/[id]">) {
  const { id } = await params;
  const me = await requireStaff();
  const db = await createClient();
  const { data: h } = await db
    .from("account_handoffs")
    .select(
      "id, kind, status, doc, error, chat, created_at, to_id, seen_at, via, moved, clients(name, slug), to:profiles!account_handoffs_to_id_fkey(full_name), from:profiles!account_handoffs_from_id_fkey(full_name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!h) notFound();
  const client = h.clients as unknown as { name: string; slug: string };
  const to = (h.to as unknown as { full_name: string } | null)?.full_name ?? "the new buyer";
  const from = (h.from as unknown as { full_name: string } | null)?.full_name ?? null;
  const comeback = h.kind === "comeback";
  const d = comeback ? null : (h.doc as HandoffDoc | null);
  const cb = comeback ? (h.doc as ComebackDoc | null) : null;
  const moved = (h.moved ?? {}) as { kpis?: number; tickets?: number; held?: number; sprints?: number };
  const date = new Date(h.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });
  const movedLine = [
    moved.kpis ? `${moved.kpis} KPI${moved.kpis === 1 ? "" : "s"}` : null,
    moved.tickets ? `${moved.tickets} open ticket${moved.tickets === 1 ? "" : "s"}` : null,
    moved.sprints ? "the optimization sprint" : null,
  ].filter(Boolean);

  return (
    <div className="min-h-screen bg-[#f4f2f1] px-4 py-8 text-[#17131a] print:bg-white print:p-0 [color-scheme:light]">
      <style>{`@page { size: letter; margin: 0.6in; } @media print { .no-print { display: none !important } }`}</style>
      {me.id === h.to_id && !h.seen_at && h.status === "ready" && <Seen id={id} />}
      <HandoffBar id={id} slug={client.slug} ready={h.status === "ready"} />
      <div className="mx-auto grid max-w-[1240px] items-start gap-6 lg:grid-cols-[minmax(0,8.5in)_minmax(320px,1fr)] print:block">
        <article className="grid gap-10 rounded-[6px] bg-white px-6 py-10 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.35)] sm:px-10 sm:py-12 print:rounded-none print:p-0 print:shadow-none">
          <header className="grid gap-6 border-b border-[#e7e2e3] pb-8">
            <div className="flex items-center justify-between gap-4">
              <Image src="/kaizen-logo.png" alt="Kaizen Marketing" width={120} height={28} className="h-7 w-auto" />
              <p className="text-xs uppercase tracking-[0.18em] text-[#8a8189]">{comeback ? "Back live" : "Account handoff"} · {date}</p>
            </div>
            <div className="grid gap-2">
              <p className="text-sm font-medium text-[#c8102e]">
                {client.name} · {comeback ? `picking it back up, for ${to}` : from ? `${from} → ${to}` : `for ${to}`}
              </p>
              <h1 className="text-[24px] font-semibold leading-[1.2] tracking-tight sm:text-[28px]">{(cb ?? d)?.headline ?? (comeback ? `${client.name} is back` : `${client.name} is yours now`)}</h1>
              {(cb ?? d) && <p className="max-w-[62ch] text-[15px] leading-relaxed text-[#4d464f]">{(cb ?? d)!.summary}</p>}
              {movedLine.length > 0 && <p className="text-xs text-[#8a8189]">Moved to {to}: {movedLine.join(", ")}.</p>}
            </div>
          </header>

          {comeback ? (
            cb ? (
              <Comeback d={cb} client={client.name} />
            ) : (
              <Writing id={id} status={h.status} error={h.error} />
            )
          ) : !d ? (
            <Writing id={id} status={h.status} error={h.error} />
          ) : (
            <>
              <Part n="1" title="Dos and don'ts">
                <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
                  <Rules tone="do" title="Do" items={d.dos} />
                  <Rules tone="dont" title="Don't" items={d.donts} />
                </div>
              </Part>

              <Part n="2" title="What's in motion">
                {d.inMotion.length ? (
                  <ul className="grid gap-2">
                    {d.inMotion.map((m, i) => (
                      <li key={i} className="grid gap-0.5 rounded-[8px] border border-[#e7e2e3] px-4 py-3 break-inside-avoid">
                        <p className="text-[14px] font-medium">{m.what}</p>
                        <p className="text-[13px] leading-relaxed text-[#4d464f]">{m.status}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>Nothing open right now.</Empty>
                )}
              </Part>

              <Part n="3" title="What the client has told us (last 45 days)">
                {d.clientSaid.length ? (
                  <ol className="grid gap-3 border-l border-[#e7e2e3] pl-5">
                    {d.clientSaid.map((c, i) => (
                      <li key={i} className="relative grid gap-0.5 break-inside-avoid">
                        <span className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full bg-[#c8102e]" />
                        <p className="text-[11px] uppercase tracking-[0.12em] text-[#8a8189]">
                          {c.when} · {c.where}
                        </p>
                        <p className="text-[14px] leading-relaxed">{c.what}</p>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Empty>Nothing on record from the client in the last 45 days.</Empty>
                )}
              </Part>

              <Part n="4" title="What we've learned">
                <Bullets items={d.learnings} empty="No learnings recorded yet." />
              </Part>

              <Part n="5" title="Brand and go-to-market">
                <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
                  <Card title="Brand">
                    {d.brand.voice || d.brand.audience ? (
                      <>
                        {d.brand.voice && <Line k="Voice" v={d.brand.voice} />}
                        {d.brand.audience && <Line k="Audience" v={d.brand.audience} />}
                        {d.brand.rules.length > 0 && <Bullets items={d.brand.rules} small />}
                      </>
                    ) : (
                      <Empty>No Brand Bible yet.</Empty>
                    )}
                  </Card>
                  <Card title={`Go-to-market · ${d.gtm.stage || "unknown"}`}>
                    {d.gtm.strategy && <p className="text-[13px] leading-relaxed text-[#4d464f]">{d.gtm.strategy}</p>}
                    {d.gtm.changed && <Line k="Lately" v={d.gtm.changed} />}
                  </Card>
                </div>
              </Part>

              <Part n="6" title="Keep in mind">
                <Bullets items={d.keepInMind} empty="Nothing unusual." />
              </Part>

              {d.similar.length > 0 && (
                <Part n="7" title="Like accounts you already run">
                  <div className="grid gap-3 sm:grid-cols-2 print:grid-cols-2">
                    {d.similar.map((s, i) => (
                      <Card key={i} title={s.client}>
                        <p className="text-[13px] leading-relaxed text-[#4d464f]">{s.why}</p>
                        <Line k="Borrow" v={s.borrow} />
                      </Card>
                    ))}
                  </div>
                </Part>
              )}

              <Part n={d.similar.length ? "8" : "7"} title="Your first week">
                <ol className="grid gap-3">
                  {d.firstWeek.map((f, i) => (
                    <li key={i} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 break-inside-avoid">
                      <span className="grid h-7 w-7 place-items-center rounded-full bg-[#fbe7ea] text-xs font-semibold text-[#c8102e]">{i + 1}</span>
                      <p className="pt-1 text-[14px] leading-relaxed">{f}</p>
                    </li>
                  ))}
                </ol>
              </Part>

              <footer className="border-t border-[#e7e2e3] pt-6 text-[11px] text-[#8a8189]">
                Written by Kaizen Ads from {client.name}&apos;s page, calls, docs, tickets and sprint. Internal only.
              </footer>
            </>
          )}
        </article>

        <AccountChat id={id} client={client.name} initial={(h.chat ?? []) as ChatTurn[]} ready={h.status === "ready"} />
      </div>
    </div>
  );
}

/** The comeback brief: where we left the account, what happened while we were away, where it is now, how to restart. */
function Comeback({ d, client }: { d: ComebackDoc; client: string }) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3 print:grid-cols-3">
        <Stat k="Last worked" v={d.away.since} />
        <Stat k="Away for" v={d.away.length} />
        <Stat k="Why we stopped" v={d.away.why} />
      </div>

      <Part n="1" title="Where we left it">
        <p className="max-w-[66ch] text-[14px] leading-relaxed">{d.leftOff.state}</p>
        <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
          <Card title="Last moves in the account">
            <Bullets items={d.leftOff.lastMoves} empty="No changes on record." small />
          </Card>
          <Card title="Left unfinished">
            <Bullets items={d.leftOff.unfinished} empty="Nothing was left open." small />
          </Card>
        </div>
      </Part>

      <Part n="2" title="While we were away">
        {d.sinceThen.length ? (
          <ol className="grid gap-3 border-l border-[#e7e2e3] pl-5">
            {d.sinceThen.map((x, i) => (
              <li key={i} className="relative text-[14px] leading-relaxed break-inside-avoid">
                <span className="absolute -left-[25px] top-2 h-2 w-2 rounded-full bg-[#c8102e]" />
                {x}
              </li>
            ))}
          </ol>
        ) : (
          <Empty>Nothing on record while the account was off.</Empty>
        )}
      </Part>

      <Part n="3" title="Where it is today">
        <p className="max-w-[66ch] rounded-[8px] bg-[#f7f5f4] px-4 py-3 text-[14px] leading-relaxed">{d.now}</p>
      </Part>

      <Part n="4" title="Picking it back up">
        <ol className="grid gap-3">
          {d.restart.map((r, i) => (
            <li key={i} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 break-inside-avoid">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-[#fbe7ea] text-xs font-semibold text-[#c8102e]">{i + 1}</span>
              <span className="grid gap-0.5 pt-1">
                <span className="text-[14px] font-medium leading-relaxed">{r.step}</span>
                <span className="text-[13px] leading-relaxed text-[#4d464f]">{r.why}</span>
              </span>
            </li>
          ))}
        </ol>
      </Part>

      <Part n="5" title="Confirm with the client">
        <Bullets items={d.askClient} empty="Nothing to confirm." />
      </Part>

      <Part n="6" title="Dos and don'ts">
        <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
          <Rules tone="do" title="Do" items={d.dos} />
          <Rules tone="dont" title="Don't" items={d.donts} />
        </div>
      </Part>

      <Part n="7" title="Keep in mind">
        <Bullets items={d.keepInMind} empty="Nothing unusual." />
      </Part>

      <footer className="border-t border-[#e7e2e3] pt-6 text-[11px] text-[#8a8189]">
        Written by Kaizen Ads after a full sync of {client}&apos;s ad accounts, Slack, email and Drive. Internal only.
      </footer>
    </>
  );
}

const Stat = ({ k, v }: { k: string; v: string }) => (
  <div className="grid content-start gap-1 rounded-[8px] border border-[#e7e2e3] px-4 py-3 break-inside-avoid">
    <p className="text-[11px] uppercase tracking-[0.14em] text-[#8a8189]">{k}</p>
    <p className="text-[14px] font-medium leading-snug">{v}</p>
  </div>
);

function Part({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4">
      <div className="flex items-baseline gap-3">
        <span className="text-sm font-semibold text-[#c8102e]">{n}</span>
        <h2 className="text-[20px] font-semibold tracking-tight sm:text-[22px]">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Rules({ tone, title, items }: { tone: "do" | "dont"; title: string; items: string[] }) {
  return (
    <div className={`grid content-start gap-2 rounded-[8px] p-4 break-inside-avoid ${tone === "do" ? "bg-[#eef6f0]" : "bg-[#fbe7ea]"}`}>
      <p className={`text-xs font-semibold uppercase tracking-[0.14em] ${tone === "do" ? "text-[#1f7a43]" : "text-[#c8102e]"}`}>{title}</p>
      {items.length ? (
        <ul className="grid gap-1.5">
          {items.map((x, i) => (
            <li key={i} className="text-[13.5px] leading-relaxed">
              {x}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[13px] text-[#8a8189]">None recorded.</p>
      )}
    </div>
  );
}

function Bullets({ items, empty, small }: { items: string[]; empty?: string; small?: boolean }) {
  if (!items.length) return empty ? <Empty>{empty}</Empty> : null;
  return (
    <ul className="grid gap-2">
      {items.map((x, i) => (
        <li key={i} className={`grid grid-cols-[12px_minmax(0,1fr)] gap-2 leading-relaxed break-inside-avoid ${small ? "text-[13px] text-[#4d464f]" : "text-[14px]"}`}>
          <span className="mt-[9px] h-1.5 w-1.5 rounded-full bg-[#c8102e]" />
          {x}
        </li>
      ))}
    </ul>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-2 rounded-[8px] border border-[#e7e2e3] p-4 break-inside-avoid">
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {children}
    </div>
  );
}

const Line = ({ k, v }: { k: string; v: string }) => (
  <p className="text-[13px] leading-relaxed text-[#4d464f]">
    <span className="font-medium text-[#17131a]">{k}: </span>
    {v}
  </p>
);
const Empty = ({ children }: { children: React.ReactNode }) => <p className="text-[13px] text-[#8a8189]">{children}</p>;
