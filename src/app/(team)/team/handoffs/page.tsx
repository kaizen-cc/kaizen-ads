import type { Metadata } from "next";
import { Suspense } from "react";
import { requireStaff } from "@/lib/auth";
import { canChangeBuyer } from "@/lib/chat-permissions";
import { linesFor, mayTransferAny } from "@/lib/seat-transfer-core";
import { createAdminClient } from "@/lib/supabase/admin";
import { HandoffsView } from "./handoffs-view";

export const metadata: Metadata = { title: "Handoffs" };

// Moving accounts between people: every plan the assistant made (someone's seats to someone else), each move with the
// handoff written for the new person, to approve, change or drop. Single seat changes planned in a chat show here too.

export default async function HandoffsPage({ searchParams }: PageProps<"/team/handoffs">) {
  const me = await requireStaff();
  if (!mayTransferAny(me))
    return (
      <div className="mx-auto grid max-w-xl gap-2 py-16 text-center">
        <h1 className="font-heading text-[24px]">Handoffs</h1>
        <p className="text-[14px] text-muted">Moving accounts between people is for the executives and the line heads.</p>
      </div>
    );
  const sp = await searchParams;
  const focus = typeof sp.t === "string" ? sp.t : null;
  const admin = createAdminClient();
  const { loadTransfers, pendingTeamChanges } = await import("@/lib/seat-transfer");
  const asker = { id: me.id, fullName: me.fullName, role: me.role, isExec: me.isExec };
  const [transfers, singles] = await Promise.all([
    loadTransfers(admin, asker),
    canChangeBuyer(me).ok
      ? pendingTeamChanges(admin)
      : Promise.resolve([] as string[]),
  ]);
  return (
    <Suspense>
      <HandoffsView transfers={transfers} singles={singles} focus={focus} lines={linesFor(me)} exec={me.isExec} />
    </Suspense>
  );
}
