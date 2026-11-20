import Link from "next/link";
import { duration } from "@/lib/activity";
import { importSummary } from "@/lib/kaizen-ai/imports-summary";

// Execs: everyone who has joined, the least use of Kaizen OS first (time in use over the last four weeks and when they
// were last on), with whether they've imported anything into Kaizen AI.

export type UsageRow = { id: string; name: string; lastActive: string | null; lastActiveAt: string | null; minutes: number; imports: { chats: number; projects: number; docs: number } | null };

export function UsageReport({ rows }: { rows: UsageRow[] }) {
  if (!rows.length) return null;
  const imported = rows.filter((r) => importSummary(r.imports)).length;
  return (
    <section aria-label="Usage by person" className="grid gap-3 rounded-[18px] border border-line bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-heading text-[16px]">Usage by person</h2>
        <p className="text-xs text-faint">
          Least used first · last 4 weeks · {imported} of {rows.length} imported into Kaizen AI
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-left text-[13px]">
          <thead className="text-[11px] text-faint">
            <tr>
              <th className="py-1.5 pr-3 font-normal">Person</th>
              <th className="py-1.5 pr-3 font-normal">Last active</th>
              <th className="py-1.5 pr-3 font-normal">Time in use</th>
              <th className="py-1.5 font-normal">Kaizen AI imports</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => {
              const summary = importSummary(r.imports);
              return (
                <tr key={r.id}>
                  <td className="py-2 pr-3">
                    <Link href={`/team/${r.id}`} className="hover:underline">
                      {r.name}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-muted">{r.lastActive ? (r.lastActive === "now" ? "Now" : r.lastActive) : "Never"}</td>
                  <td className="py-2 pr-3 text-muted">{r.minutes ? duration(r.minutes) : "None"}</td>
                  <td className={`py-2 ${summary ? "text-ok" : "text-faint"}`}>{summary ?? "Not yet"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
