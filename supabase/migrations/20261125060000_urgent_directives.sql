-- Time-sensitive directives from leadership come through as urgent assistant alerts (Nov 20 2026). Before, only an
-- exec's ask due today rang the assistant. Now anyone in leadership (execs, line heads, the creative leads) asking a
-- teammate for something that's urgent (agent_asks.urgent) or due today or late queues a heads-up: a ring when
-- they're in the app, else an unread alert in their assistant chat.
alter table public.agent_asks add column if not exists urgent boolean not null default false;

create or replace function private.heads_up_from_ask()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_exec boolean; v_lead boolean; v_role text; v_name text;
begin
  if new.owner_id = new.asked_by or new.status <> 'open' then return new; end if;
  if not coalesce(new.urgent, false) and (new.due_on is null or new.due_on > (now() at time zone 'America/New_York')::date) then return new; end if;
  select is_exec, is_lead, role::text, coalesce(nullif(display_name, ''), full_name) into v_exec, v_lead, v_role, v_name from public.profiles where id = new.asked_by;
  if not (coalesce(v_exec, false) or coalesce(v_lead, false) or v_role like 'head_of_%' or v_role in ('lead_graphic_designer', 'lead_video_editor')) then return new; end if;
  perform private.queue_heads_up(
    new.owner_id,
    'ask:' || new.id,
    coalesce(split_part(v_name, ' ', 1), 'Leadership') || case when coalesce(new.urgent, false) then ', urgent: ' else ' needs this today: ' end || new.title,
    nullif(new.detail, ''),
    '/pipeline#next',
    new.client_id
  );
  return new;
end $$;
