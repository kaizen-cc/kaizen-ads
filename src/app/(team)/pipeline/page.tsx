import Link from "next/link";
import { requireStaff } from "@/lib/auth";

// The ten stages mirror the Asana Creative board, in order.
const STAGES = [
  { name: "Requested", owner: "auto-assigned creative" },
  { name: "In production", owner: "designer / editor" },
  { name: "Internal review", owner: "Jesus" },
  { name: "Copy", owner: "AI draft" },
  { name: "Copy review", owner: "Camille" },
  { name: "Ready for client", owner: "Jorgi" },
  { name: "Client review", owner: "client · Jorgi tracks" },
  { name: "Client revision", owner: "routed automatically" },
  { name: "Ready for launch", owner: "media buyer" },
  { name: "Launched", owner: "" },
];

export default async function Pipeline() {
  const me = await requireStaff();
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">Pipeline</h1>
          <p className="mt-1 text-sm text-muted">Welcome, {me.fullName.split(" ")[0]}. Every creative request will move through these stages.</p>
        </div>
        <span className="rounded-full bg-surface-2 px-3 py-1 text-xs text-muted">Requests and uploads arrive in the next phase</span>
      </div>

      <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-2 md:mx-0 md:px-0">
        {STAGES.map((s) => (
          <section key={s.name} className="grid w-56 shrink-0 content-start gap-2 rounded-brand bg-surface-2 p-2">
            <header className="flex items-baseline justify-between px-1 pt-1">
              <h2 className="text-sm font-medium">{s.name}</h2>
              <span className="tabular text-xs text-muted">0</span>
            </header>
            {s.owner && <p className="px-1 text-[11px] text-faint">{s.owner}</p>}
            <div className="grid h-24 place-items-center rounded-brand border border-dashed border-line text-xs text-faint">
              Nothing here yet
            </div>
          </section>
        ))}
      </div>

      <p className="text-sm text-muted">
        In the meantime, check that each <Link href="/clients" className="text-brand-text hover:underline">client</Link> has the right buyer, designer, editor and contacts.
      </p>
    </div>
  );
}
