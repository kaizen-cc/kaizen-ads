-- Sales call briefs paused (Nov 24 2026): personal and recurring internal events were classified as sales calls and
-- one was briefed. Writing stays off (the calls are still found and listed) until the stricter classification's list
-- has been checked; switch back on with value {"write": true}.
insert into public.app_settings (key, value) values ('sales_briefs', '{"write": false, "why": "paused Nov 24 after personal events were classified as sales calls"}'::jsonb)
on conflict (key) do update set value = excluded.value;
