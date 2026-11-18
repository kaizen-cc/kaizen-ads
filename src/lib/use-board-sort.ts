"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { defaultDir, parseDir, parseSort, type SortDir, type SortKey } from "@/lib/board-sort";
import { pushParams } from "@/lib/url-state";

// The board's sort lives in the address (?sort=due&dir=asc) and is remembered for the person (per board), so the next
// visit opens sorted the way they left it. Storage can be blocked: everything works without it.
const store = (board: string) => `kz-board-sort:${board}`;

export function useBoardSort(board: "creative" | "email") {
  const params = useSearchParams();
  const [saved, setSaved] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(store(board));
      const [k, d] = (raw ?? "").split(":");
      const key = parseSort(k);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once after mount: storage isn't there on the server
      if (key) setSaved({ key, dir: parseDir(d) ?? defaultDir(key) });
    } catch {
      // blocked storage: no remembered sort
    }
  }, [board]);
  const fromUrl = parseSort(params.get("sort"));
  const key = fromUrl ?? (saved?.key ?? null);
  const dir = fromUrl ? (parseDir(params.get("dir")) ?? defaultDir(fromUrl)) : (saved?.dir ?? "asc");
  const set = (next: SortKey | null, nextDir?: SortDir) => {
    const d = next ? (nextDir ?? defaultDir(next)) : null;
    try {
      if (next && d) window.localStorage.setItem(store(board), `${next}:${d}`);
      else window.localStorage.removeItem(store(board));
    } catch {
      // blocked storage
    }
    setSaved(next && d ? { key: next, dir: d } : null);
    // Choosing "no sort" clears the remembered one too
    pushParams({ sort: next, dir: d });
  };
  return { key, dir, set };
}
