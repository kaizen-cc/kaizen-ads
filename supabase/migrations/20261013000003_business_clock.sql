-- Kaizen Ads — business clock
-- Kaizen works Mon–Fri, 08:00–18:00 America/New_York, minus the `holidays` table.
-- "24h" and "48h" mean 1 and 2 business days: something sent Friday 7pm starts counting
-- Monday 8am, so its 24h reminder is Tuesday 8am (Friday 5pm is still inside hours → Monday 5pm). Due dates and reminders use these functions.

create function public.is_business_day(p_day date) returns boolean
language sql stable security definer set search_path = '' as $$
  select extract(isodow from p_day) < 6
     and not exists (select 1 from public.holidays where day = p_day)
$$;

-- The first moment at or after p_ts that falls inside business hours.
create function public.business_clamp(p_ts timestamptz) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_local timestamp := p_ts at time zone 'America/New_York';
  v_day   date      := v_local::date;
begin
  if public.is_business_day(v_day) and v_local::time >= time '08:00' and v_local::time < time '18:00' then
    return p_ts;
  end if;
  -- before opening on a business day: same day 08:00
  if public.is_business_day(v_day) and v_local::time < time '08:00' then
    return (v_day + time '08:00') at time zone 'America/New_York';
  end if;
  -- otherwise: next business day 08:00
  loop
    v_day := v_day + 1;
    exit when public.is_business_day(v_day);
  end loop;
  return (v_day + time '08:00') at time zone 'America/New_York';
end $$;

-- p_days business days after p_ts (clamped into business hours first), same local time of day.
create function public.add_business_days(p_ts timestamptz, p_days int) returns timestamptz
language plpgsql stable security definer set search_path = '' as $$
declare
  v_start timestamp := public.business_clamp(p_ts) at time zone 'America/New_York';
  v_day   date      := v_start::date;
  v_left  int       := greatest(p_days, 0);
begin
  while v_left > 0 loop
    v_day := v_day + 1;
    if public.is_business_day(v_day) then
      v_left := v_left - 1;
    end if;
  end loop;
  return (v_day + v_start::time) at time zone 'America/New_York';
end $$;

-- "Same day": 18:00 on the business day the work lands on (after hours rolls to the next one).
create function public.end_of_business_day(p_ts timestamptz) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select ((public.business_clamp(p_ts) at time zone 'America/New_York')::date + time '18:00')
         at time zone 'America/New_York'
$$;

-- Business minutes elapsed between two moments (10 business hours per business day).
create function public.business_minutes_between(p_from timestamptz, p_to timestamptz) returns int
language plpgsql stable security definer set search_path = '' as $$
declare
  v_from  timestamp;
  v_to    timestamp := p_to at time zone 'America/New_York';
  v_day   date;
  v_open  timestamp;
  v_close timestamp;
  v_total numeric := 0;
begin
  if p_to <= p_from then return 0; end if;
  v_from := p_from at time zone 'America/New_York';
  v_day := v_from::date;
  while v_day <= v_to::date loop
    if public.is_business_day(v_day) then
      v_open  := greatest(v_day + time '08:00', v_from);
      v_close := least(v_day + time '18:00', v_to);
      if v_close > v_open then
        v_total := v_total + extract(epoch from v_close - v_open) / 60;
      end if;
    end if;
    v_day := v_day + 1;
  end loop;
  return floor(v_total)::int;
end $$;

grant execute on function public.is_business_day(date) to authenticated;
grant execute on function public.business_clamp(timestamptz) to authenticated;
grant execute on function public.add_business_days(timestamptz, int) to authenticated;
grant execute on function public.end_of_business_day(timestamptz) to authenticated;
grant execute on function public.business_minutes_between(timestamptz, timestamptz) to authenticated;
revoke execute on function public.is_business_day(date) from anon;
revoke execute on function public.business_clamp(timestamptz) from anon;
revoke execute on function public.add_business_days(timestamptz, int) from anon;
revoke execute on function public.end_of_business_day(timestamptz) from anon;
revoke execute on function public.business_minutes_between(timestamptz, timestamptz) from anon;
