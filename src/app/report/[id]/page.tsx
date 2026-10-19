import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import type { ClientReport } from "@/lib/sprints";
import { createClient } from "@/lib/supabase/server";
import { PrintBar, WriteReport } from "./report-parts";

export const metadata: Metadata = { title: "Account review", robots: { index: false, follow: false } };
export const maxDuration = 300;

/**
 * The client's version of an account audit, laid out for a PDF: what we found, what we're doing, what we're watching.
 * Kaizen's voice, no internal names or tools. Opened by the team, saved as a PDF from the browser, sent to the client.
 */
export default async function ClientReportPage({ params }: PageProps<"/report/[id]">) {
  const { id } = await params;
  await requireStaff();
  const supabase = await createClient();
  const { data: a } = await supabase.from("account_audits").select("id, status, client_report, created_at, clients(name), kpi_targets(label)").eq("id", id).maybeSingle();
  if (!a || a.status !== "ready") notFound();
  const client = (a.clients as unknown as { name: string } | null)?.name ?? "";
  const r = a.client_report as ClientReport | null;
  const date = new Date(a.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });

  return (
    <div className="min-h-screen bg-[#f4f2f1] px-4 py-8 text-[#17131a] print:bg-white print:p-0 [color-scheme:light]">
      <style>{`@page { size: letter; margin: 0.6in; } @media print { .no-print { display: none !important } }`}</style>
      <PrintBar auditId={id} ready={Boolean(r)} />
      <article className="mx-auto grid max-w-[8.5in] gap-10 rounded-[6px] bg-white px-10 py-12 shadow-[0_30px_80px_-40px_rgba(0,0,0,0.35)] print:max-w-none print:rounded-none print:p-0 print:shadow-none">
        <header className="grid gap-6 border-b border-[#e7e2e3] pb-8">
          <div className="flex items-center justify-between gap-4">
            <Image src="/kaizen-logo.png" alt="Kaizen Marketing" width={120} height={28} className="h-7 w-auto" />
            <p className="text-xs uppercase tracking-[0.18em] text-[#8a8189]">Account review · {date}</p>
          </div>
          <div className="grid gap-2">
            <p className="text-sm font-medium text-[#c8102e]">{client}</p>
            <h1 className="text-[32px] font-semibold leading-[1.1] tracking-tight">{r?.headline ?? "Your account review"}</h1>
            {r && <p className="max-w-[60ch] text-[15px] leading-relaxed text-[#4d464f]">{r.summary}</p>}
          </div>
        </header>

        {!r ? (
          <WriteReport auditId={id} />
        ) : (
          <>
            <Part n="1" title="What we found">
              <div className="grid gap-4">
                {r.found.map((f, i) => (
                  <div key={i} className="grid gap-1 break-inside-avoid">
                    <h3 className="text-[15px] font-semibold">{f.title}</h3>
                    <p className="text-[14px] leading-relaxed text-[#4d464f]">{f.detail}</p>
                  </div>
                ))}
              </div>
            </Part>
            <Part n="2" title="What we're doing">
              <ol className="grid gap-4">
                {r.doing.map((d, i) => (
                  <li key={i} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 break-inside-avoid">
                    <span className="grid h-7 w-7 place-items-center rounded-full bg-[#fbe7ea] text-xs font-semibold text-[#c8102e]">{i + 1}</span>
                    <div className="grid gap-1">
                      <h3 className="text-[15px] font-semibold">
                        {d.title} <span className="font-normal text-[#8a8189]">· {d.when}</span>
                      </h3>
                      <p className="text-[14px] leading-relaxed text-[#4d464f]">{d.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Part>
            <Part n="3" title="What we're watching">
              <div className="grid gap-3 sm:grid-cols-2 print:grid-cols-2">
                {r.watching.map((w, i) => (
                  <div key={i} className="grid gap-1 rounded-[8px] border border-[#e7e2e3] p-4 break-inside-avoid">
                    <h3 className="text-[14px] font-semibold">{w.title}</h3>
                    <p className="text-[13px] leading-relaxed text-[#4d464f]">{w.detail}</p>
                  </div>
                ))}
              </div>
            </Part>
            <footer className="grid gap-1 border-t border-[#e7e2e3] pt-6 text-[13px] text-[#4d464f]">
              <p className="font-semibold text-[#17131a]">Next update</p>
              <p>{r.nextUpdate}</p>
              <p className="mt-4 text-[11px] text-[#8a8189]">Prepared by Kaizen Marketing for {client}.</p>
            </footer>
          </>
        )}
      </article>
    </div>
  );
}

function Part({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-4">
      <div className="flex items-baseline gap-3">
        <span className="text-sm font-semibold text-[#c8102e]">{n}</span>
        <h2 className="text-[22px] font-semibold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  );
}
