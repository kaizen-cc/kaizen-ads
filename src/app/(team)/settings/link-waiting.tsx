"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { linkWaiting } from "./store-link-actions";

// One store waiting to be linked: search the client it belongs to, pick, Link. The store's history starts reading
// right after.

export function LinkWaiting({ shop, name, clients, canLink }: { shop: string; name: string | null; clients: { id: string; name: string }[]; canLink: boolean }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? clients.filter((c) => c.name.toLowerCase().includes(t)).slice(0, 6) : [];
  }, [q, clients]);
  return (
    <div className="grid gap-2 rounded-[12px] border border-line bg-surface px-3.5 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3">
        <span className="font-medium">{name ?? shop}</span>
        <span className="text-[12px] text-faint">{shop}</span>
      </div>
      {done ? (
        <p className="text-[13px] text-ok">
          Linked.{" "}
          <Link href={`/clients/${done}#store`} className="underline">
            Open the client
          </Link>
        </p>
      ) : canLink ? (
        <div className="grid gap-2">
          {pick ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-muted">
                Link to <b className="text-fg">{pick.name}</b>
              </span>
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await linkWaiting(shop, pick.id);
                    if (!r.ok) return setError(r.error);
                    setError(null);
                    setDone(r.slug);
                    router.refresh();
                  })
                }
                className="h-11 rounded-full bg-brand px-5 text-sm font-medium text-white disabled:opacity-50 md:h-9"
              >
                {pending ? "Linking…" : "Link"}
              </button>
              <button type="button" onClick={() => setPick(null)} className="h-11 px-2 text-[13px] text-muted hover:text-fg md:h-9">
                Change
              </button>
            </div>
          ) : (
            <div className="relative">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Which client is this store?" aria-label={`Client for ${shop}`} autoComplete="off" className="h-11 w-full rounded-[10px] border border-line bg-bg px-3 text-base outline-none focus:border-brand-text/60 md:text-sm" />
              {hits.length > 0 && (
                <ul className="mt-1 grid overflow-hidden rounded-[10px] border border-line bg-surface">
                  {hits.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setPick(c);
                          setQ("");
                        }}
                        className="min-h-11 w-full px-3 py-2 text-left text-sm hover:bg-surface-2"
                      >
                        {c.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && <p className="text-[12.5px] text-bad">{error}</p>}
        </div>
      ) : (
        <p className="text-[12.5px] text-faint">An exec or team lead links it to its client.</p>
      )}
    </div>
  );
}
