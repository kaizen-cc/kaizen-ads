-- Kaizen Ads — creative packages and allotment usage
-- Only clients on a creative package can get creative requests. Everyone else still shows in the
-- request form, greyed out, as an upsell prompt. Enabling a client (later: from the upsell and
-- enrollment forms) is flipping creative_package and setting their monthly allotment.

alter table public.clients add column creative_package boolean not null default false;

-- Clients on a creative package as of 2026-10-14
update public.clients set creative_package = true
where name in (
  'Limelight Entertainment', 'Best Tickets', 'Idalia Photography', 'Sierra Dreams', 'OceanBox', 'Nectr',
  'The Rowan Apartments', 'Craigmont Downtown', 'Good Trash', 'Leap Funding', 'Fast Conversational Spanish',
  '1320 Motorsports', '7th Dimension Aesthetics', 'Crust Pizza Co.', 'Atlas Print Solutions', 'Blue Spring Day School',
  'BKI/Boston Paintball', 'Children''s House Montessori School', 'Extreme Velocity', 'Fun On The Run Paintball Park',
  'Giant Texas', 'Holland Law Group', 'Liberty Day School', 'Lice Treatment Center', 'Splat Houston', 'Shupe Legal',
  'Tejas Brewery', 'X Factor Paintball', 'Aldecoa Coffee', 'The Bedminster Tavern', 'Darling Psychology',
  'Giant Party Sports', 'Goodmellow', 'Inferno Martial Arts', 'Wild World Paintball', 'Union Hill Day School'
);

-- ─── This month's allotment use ────────────────────────────────────────────
-- Counts deliverables requested this calendar month (New York time). Net new designs count;
-- variations don't. Images and carousels draw on the image allotment, videos on the video one.
create view public.client_allotment_usage with (security_invoker = on) as
with month as (
  select (date_trunc('month', now() at time zone 'America/New_York') at time zone 'America/New_York') as starts
)
select c.id as client_id,
  a.images_per_month,
  a.videos_per_month,
  coalesce(sum(r.new_count) filter (where r.format in ('image', 'carousel')), 0)::int as images_used,
  coalesce(sum(r.new_count) filter (where r.format = 'video'), 0)::int as videos_used
from public.clients c
left join public.client_allotments a on a.client_id = c.id
left join public.requests r on r.client_id = c.id and r.created_at >= (select starts from month)
where c.creative_package
group by c.id, a.images_per_month, a.videos_per_month;

grant select on public.client_allotment_usage to authenticated;

-- ─── Requests need a creative package ──────────────────────────────────────
create function private.assert_creative_package(p_client uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.clients where id = p_client and creative_package) then
    raise exception 'This client isn''t on a creative package';
  end if;
end $$;
revoke execute on function private.assert_creative_package(uuid) from public, anon;
grant execute on function private.assert_creative_package(uuid) to authenticated;

-- Wrap the existing entry points: same bodies, plus the package check up front.
alter function public.create_request_batch(uuid, text, jsonb, public.request_priority, text, text, text, text[], text[], jsonb)
  rename to create_request_batch_unchecked;
alter function public.create_request(uuid, text, public.creative_format, public.request_kind, public.request_priority, text, text, text, text[], text[], int)
  rename to create_request_unchecked;
alter function public.create_request_batch_unchecked(uuid, text, jsonb, public.request_priority, text, text, text, text[], text[], jsonb) set schema private;
alter function public.create_request_unchecked(uuid, text, public.creative_format, public.request_kind, public.request_priority, text, text, text, text[], text[], int) set schema private;

create function public.create_request_batch(
  p_client uuid, p_title text, p_items jsonb,
  p_priority public.request_priority default 'normal',
  p_angle text default null, p_audience text default null, p_brief text default null,
  p_refs text[] default '{}', p_sizes text[] default '{}', p_ai_review jsonb default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_creative_package(p_client);
  return private.create_request_batch_unchecked(p_client, p_title, p_items, p_priority, p_angle, p_audience, p_brief, p_refs, p_sizes, p_ai_review);
end $$;

create function public.create_request(
  p_client uuid, p_title text, p_format public.creative_format,
  p_kind public.request_kind default 'new', p_priority public.request_priority default 'normal',
  p_angle text default null, p_audience text default null, p_brief text default null,
  p_refs text[] default '{}', p_sizes text[] default '{}', p_quantity int default 1
) returns uuid
language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_creative_package(p_client);
  return private.create_request_unchecked(p_client, p_title, p_format, p_kind, p_priority, p_angle, p_audience, p_brief, p_refs, p_sizes, p_quantity);
end $$;

revoke execute on function private.create_request_batch_unchecked(uuid, text, jsonb, public.request_priority, text, text, text, text[], text[], jsonb) from public, anon, authenticated;
revoke execute on function private.create_request_unchecked(uuid, text, public.creative_format, public.request_kind, public.request_priority, text, text, text, text[], text[], int) from public, anon, authenticated;
revoke execute on function public.create_request_batch(uuid, text, jsonb, public.request_priority, text, text, text, text[], text[], jsonb) from public, anon;
revoke execute on function public.create_request(uuid, text, public.creative_format, public.request_kind, public.request_priority, text, text, text, text[], text[], int) from public, anon;
grant execute on function public.create_request_batch(uuid, text, jsonb, public.request_priority, text, text, text, text[], text[], jsonb) to authenticated;
grant execute on function public.create_request(uuid, text, public.creative_format, public.request_kind, public.request_priority, text, text, text, text[], text[], int) to authenticated;
