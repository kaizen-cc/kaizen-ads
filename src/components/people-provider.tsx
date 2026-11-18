"use client";

import { useMemo } from "react";
import { PeopleCtx, peopleKey, type PersonEntry } from "@/lib/people-context";

/** The team's pictures and profile links for every avatar below (see people-context.ts) */
export function PeopleProvider({ people, children }: { people: { name: string; id: string; url: string | null; display: string }[]; children: React.ReactNode }) {
  const map = useMemo(() => new Map<string, PersonEntry>(people.map((p) => [peopleKey(p.name), { id: p.id, url: p.url, display: p.display }])), [people]);
  return <PeopleCtx.Provider value={map}>{children}</PeopleCtx.Provider>;
}
