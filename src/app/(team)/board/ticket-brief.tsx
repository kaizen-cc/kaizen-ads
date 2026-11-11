"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BriefCheck } from "@/components/brief-check";
import { BriefText } from "@/components/brief-sheet";
import { exportLineFor } from "@/lib/brief-spec";
import type { Ticket } from "./types";

// The brief on a ticket: its sections as the maker reads them, and under it the same check and revise chat as Ready to
// send (corrections are saved on the ticket at once, each one logged and undoable), with the review stamp.
export function TicketBrief({ ticket, demo = false }: { ticket: Ticket; demo?: boolean }) {
  const router = useRouter();
  const [brief, setBrief] = useState(ticket.brief ?? "");
  const [sizes, setSizes] = useState(ticket.sizes);
  if (!brief.trim()) return <p className="text-sm text-faint">No brief written.</p>;
  return (
    <div className="grid min-w-0 gap-3">
      <div className="rounded-[10px] border border-line bg-surface px-5 py-4 max-md:px-4">
        <BriefText text={brief} exportLine={exportLineFor([ticket.format], sizes, ticket.clientName, ticket.title)} />
      </div>
      <BriefCheck
        demo={demo}
        brief={brief}
        signature={`${brief}\u0000${sizes.join(",")}`}
        target={{ kind: "ticket", requestId: ticket.id }}
        onChange={(c) => {
          setBrief(c.brief);
          if (c.sizes) setSizes(c.sizes);
          router.refresh();
        }}
      />
    </div>
  );
}
