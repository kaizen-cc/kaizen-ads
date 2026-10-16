import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Live progress for a sync job, whoever started it (the schedule or Sync now): how many items of how many are done,
// what it's on right now and which phase it's in, saved every few seconds to sync_state "run:<job>" for Sync health.

export type RunProgress = {
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  by?: string | null;
  durationMs?: number | null; // the last full run, for "faster or slower than usual"
  unit?: string;
  total?: number;
  done?: number;
  failed?: number;
  current?: string | null;
  phase?: string | null;
  error?: string | null;
  summary?: string;
};

export async function tracker(admin: SupabaseClient, job: string, unit: string) {
  const source = `run:${job}`;
  const { data } = await admin.from("sync_state").select("last_result").eq("source", source).maybeSingle();
  const prev = (data?.last_result ?? {}) as Partial<RunProgress>;
  // Started by Sync now a moment ago: keep who and when
  const handed = prev.running && prev.startedAt && Date.now() - Date.parse(prev.startedAt) < 120_000;
  const s: RunProgress = {
    running: true,
    startedAt: handed ? prev.startedAt! : new Date().toISOString(),
    by: handed ? (prev.by ?? null) : "the schedule",
    durationMs: prev.durationMs ?? null,
    unit,
    total: 0,
    done: 0,
    failed: 0,
    current: null,
    phase: null,
  };
  let lastWrite = 0;
  let writing: Promise<unknown> | null = null;
  const write = (force = false) => {
    if (!force && (Date.now() - lastWrite < 2500 || writing)) return writing ?? Promise.resolve();
    lastWrite = Date.now();
    writing = Promise.resolve(admin.from("sync_state").upsert({ source, last_run_at: new Date().toISOString(), last_result: { ...s } })).finally(() => (writing = null));
    return writing;
  };
  await write(true);
  return {
    /** How many items this run will go through (can grow as it finds more). */
    total(n: number) {
      s.total = n;
      void write();
    },
    phase(name: string, total?: number) {
      s.phase = name;
      if (total != null) {
        s.total = (s.done ?? 0) + total;
      }
      void write();
    },
    /** One item done (or failed), and what's next. */
    tick(label?: string | null, ok = true) {
      s.done = (s.done ?? 0) + 1;
      if (!ok) s.failed = (s.failed ?? 0) + 1;
      if (label !== undefined) s.current = label;
      void write();
    },
    on(label: string) {
      s.current = label;
      void write();
    },
    async finish(out: { error?: string | null; summary?: string } = {}) {
      if (writing) await writing;
      const finishedAt = new Date().toISOString();
      Object.assign(s, { running: false, finishedAt, durationMs: Date.parse(finishedAt) - Date.parse(s.startedAt), current: null, error: out.error ?? null, summary: out.summary ?? s.summary });
      await write(true);
    },
  };
}
export type Tracker = Awaited<ReturnType<typeof tracker>>;
