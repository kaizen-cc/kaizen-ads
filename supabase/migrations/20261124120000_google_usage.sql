-- Google Workspace request counts (Nov 24 2026): Google's new Workspace API tiers (Standard / Scaled) are set per API
-- and project, so every request the server makes to Gmail, Drive, Calendar, Docs, Sheets, Slides or the Directory is
-- counted by New York day, API and path ("rest" = our own call, "mcp" = Google's Workspace MCP server) and shown in
-- Settings › Calls & usage. Written in batches by the server (service role) through bump_google_usage.

create table if not exists public.google_api_usage (
  day      date not null,
  api      text not null,
  via      text not null default 'rest' check (via in ('rest', 'mcp')),
  requests integer not null default 0,
  errors   integer not null default 0,
  primary key (day, api, via)
);
alter table public.google_api_usage enable row level security;
drop policy if exists "execs read google usage" on public.google_api_usage;
create policy "execs read google usage" on public.google_api_usage for select to authenticated using ((select private.is_exec()));
grant select on public.google_api_usage to authenticated;

create or replace function public.bump_google_usage(p_rows jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.google_api_usage (day, api, via, requests, errors)
  select (r ->> 'day')::date, r ->> 'api', coalesce(r ->> 'via', 'rest'), coalesce((r ->> 'requests')::int, 0), coalesce((r ->> 'errors')::int, 0)
  from jsonb_array_elements(p_rows) r
  where r ->> 'api' is not null and r ->> 'day' is not null
  on conflict (day, api, via) do update
    set requests = google_api_usage.requests + excluded.requests, errors = google_api_usage.errors + excluded.errors;
$$;
revoke all on function public.bump_google_usage(jsonb) from public, anon, authenticated;
grant execute on function public.bump_google_usage(jsonb) to service_role;
