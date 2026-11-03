-- Google health checks and the industry-benchmark fallback (exec meeting, 2026-11-03).
-- Each sub-vertical gets Google Ads benchmarks (WordStream first) next to its Meta ones. A KPI with no target is judged
-- against its sub-vertical's benchmark, kept on the snapshot with its source; a Google account's snapshot keeps its
-- health checks (brand share, search impression share, conversion rate, CTR) for the board and every agent.

alter table public.verticals
  add column if not exists google_benchmarks    jsonb not null default '[]', -- [{ metric, good, great, unit, note, source, year }]
  add column if not exists google_benchmarks_at timestamptz;

alter table public.kpi_snapshots
  add column if not exists benchmark     jsonb, -- { value, metric, unit, source, year, vertical } when there's no target
  add column if not exists google_health jsonb; -- GoogleHealth (src/lib/google-flags.ts), last 30 days
