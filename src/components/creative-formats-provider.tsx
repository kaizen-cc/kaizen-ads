"use client";

import { createContext, useContext, useMemo } from "react";
import { CREATIVE_FORMATS, type CreativeFormat } from "@/lib/creative-formats";

// The formats the signed-in person works in (src/lib/creative-formats.ts), for every creative surface in the browser.
// Set once by the team layout from their role; without it (a preview, a test) every format shows.
// Also what they may do by role (src/lib/chat-permissions.ts): whether they write briefs and copy, and if not, why.

const Ctx = createContext<readonly CreativeFormat[]>(CREATIVE_FORMATS);

/** null: allowed; otherwise one short line saying who does it */
export type RoleCan = { briefWhy: string | null; copyWhy: string | null };
const CanCtx = createContext<RoleCan>({ briefWhy: null, copyWhy: null });

export function CreativeFormatsProvider({ formats, can, children }: { formats: CreativeFormat[]; can?: RoleCan; children: React.ReactNode }) {
  const value = useMemo(() => can ?? { briefWhy: null, copyWhy: null }, [can]);
  return (
    <Ctx.Provider value={formats}>
      <CanCtx.Provider value={value}>{children}</CanCtx.Provider>
    </Ctx.Provider>
  );
}

/** The formats the signed-in person works in */
export function useCreativeFormats(): ReadonlySet<CreativeFormat> {
  const list = useContext(Ctx);
  return useMemo(() => new Set(list), [list]);
}

/** Whether the signed-in person writes briefs and copy (a short reason when they don't) */
export function useRoleCan(): RoleCan {
  return useContext(CanCtx);
}
