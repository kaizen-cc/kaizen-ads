import Link from "next/link";
import { SLOTS, type SlotRole } from "@/lib/roles";
import { AssignSelect, type Option } from "./assign-select";

export type ClientRow = {
  id: string;
  name: string;
  slug: string;
  whiteLabel: boolean;
  contacts: number;
  assigned: Record<SlotRole, Option | null>;
};

export function ClientsTable({
  rows,
  slotOptions,
  canEdit,
  emptyText,
}: {
  rows: ClientRow[];
  slotOptions: Record<SlotRole, Option[]>;
  canEdit: boolean;
  emptyText: string;
}) {
  return (
      <div className="overflow-x-auto rounded-brand border border-line bg-surface">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2.5 font-medium">Client</th>
              {SLOTS.map((s) => (
                <th key={s.value} className="w-44 px-2 py-2.5 font-medium">
                  {s.label}
                </th>
              ))}
              <th className="w-24 px-4 py-2.5 text-right font-medium">Contacts</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-2/60">
                <td className="whitespace-nowrap px-4 py-1.5">
                  <Link href={`/clients/${r.slug}`} className="font-medium hover:text-brand-text">
                    {r.name}
                  </Link>
                  {r.whiteLabel && <span className="ml-2 text-[11px] text-faint">white label</span>}
                </td>
                {SLOTS.map((s) => (
                  <td key={s.value} className="px-2 py-1.5">
                    <AssignSelect
                      clientId={r.id}
                      slot={s.value}
                      label={s.label}
                      current={r.assigned[s.value]}
                      options={slotOptions[s.value]}
                      canEdit={canEdit}
                    />
                  </td>
                ))}
                <td className="tabular px-4 py-1.5 text-right">
                  {r.contacts ? (
                    <span className="text-muted">{r.contacts}</span>
                  ) : (
                    <Link href={`/clients/${r.slug}`} className="text-xs text-warn hover:underline">
                      Add
                    </Link>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-muted">
                  {emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
  );
}
