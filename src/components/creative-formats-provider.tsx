"use client";

import { createContext, useContext, useMemo } from "react";
import { CREATIVE_FORMATS, type CreativeFormat } from "@/lib/creative-formats";

// The formats the signed-in person works in (src/lib/creative-formats.ts), for every creative surface in the browser.
// Set once by the team layout from their role; without it (a preview, a test) every format shows.

const Ctx = createContext<readonly CreativeFormat[]>(CREATIVE_FORMATS);

export function CreativeFormatsProvider({ formats, children }: { formats: CreativeFormat[]; children: React.ReactNode }) {
  return <Ctx.Provider value={formats}>{children}</Ctx.Provider>;
}

/** The formats the signed-in person works in */
export function useCreativeFormats(): ReadonlySet<CreativeFormat> {
  const list = useContext(Ctx);
  return useMemo(() => new Set(list), [list]);
}
