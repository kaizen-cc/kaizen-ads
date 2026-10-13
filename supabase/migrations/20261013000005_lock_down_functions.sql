-- Postgres lets PUBLIC execute new functions by default, so revoking from `anon` alone isn't enough.
-- The clock functions only read `holidays` (readable by any signed-in user), so they run as the
-- caller; the sign-in trigger is never callable through the API.

alter function public.is_business_day(date)                                  security invoker;
alter function public.business_clamp(timestamptz)                            security invoker;
alter function public.add_business_days(timestamptz, int)                    security invoker;
alter function public.end_of_business_day(timestamptz)                       security invoker;
alter function public.business_minutes_between(timestamptz, timestamptz)     security invoker;

revoke execute on function public.is_business_day(date)                              from public, anon;
revoke execute on function public.business_clamp(timestamptz)                        from public, anon;
revoke execute on function public.add_business_days(timestamptz, int)                from public, anon;
revoke execute on function public.end_of_business_day(timestamptz)                   from public, anon;
revoke execute on function public.business_minutes_between(timestamptz, timestamptz) from public, anon;

revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;
revoke execute on function public.touch_updated_at()     from public, anon, authenticated;
