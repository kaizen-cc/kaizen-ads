-- One handoff for every seat, and Slack access that follows the seat.
-- 1. account_handoffs: which seat it is (every seat gets one now, not only the Meta buyer's) and the outgoing
--    person's checklist (which of the doc's handOver items they've done).
-- 2. When a handoff is ready: the new person is told (as before), the person handing over gets their checklist, and
--    the head of that seat's line is told too.
-- 3. Planned moves remember what moved and what happened in Slack.
-- 4. The Slack access audit: every run's report (who's assigned to a client but missing from its channels, what was
--    added, what couldn't be). Invites only happen while app_settings.slack_seat_sync.invite is true.

alter table public.account_handoffs add column if not exists role text not null default 'meta_buyer';
alter table public.account_handoffs add column if not exists checklist jsonb not null default '[]';

create or replace function private.notify_handoff() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_client text;
  v_seat text := replace(coalesce(new.role, 'meta_buyer'), '_', ' ');
  v_head text := case
    when new.role in ('meta_buyer', 'tiktok_buyer') then 'head_of_meta'
    when new.role = 'google_buyer' then 'head_of_google'
    when new.role in ('graphic_designer', 'video_editor') then 'head_of_creative'
    when new.role like 'email_%' then 'head_of_email'
    when new.role like 'social_%' then 'head_of_social'
    else null end;
  v_to text;
  p uuid;
begin
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then
    select name into v_client from public.clients where id = new.client_id;
    select full_name into v_to from public.profiles where id = new.to_id;
    if new.kind = 'comeback' then
      perform private.notify(new.to_id, 'handoff', format('%s is back: how to pick it up', v_client), 'Where we left the account, what changed while we were away, and the first moves to bring it back.',
        format('/handoff/%s', new.id), new.client_id, format('handoff:%s', new.id), 'critical');
    else
      perform private.notify(new.to_id, 'handoff', format('%s is yours: your handoff is ready', v_client), 'Everything about the account up to now, what''s outstanding, and a chat to ask about it.',
        format('/handoff/%s', new.id), new.client_id, format('handoff:%s', new.id), 'critical');
      -- The person handing over: what to pass on before they step away
      if new.from_id is not null and new.from_id <> new.to_id then
        perform private.notify(new.from_id, 'handoff', format('Hand over %s to %s', v_client, coalesce(v_to, 'the new person')), format('Your checklist for handing over the %s seat, so nothing drops for the client.', v_seat),
          format('/handoff/%s', new.id), new.client_id, format('handoff-out:%s', new.id), 'normal');
      end if;
      -- The line's head sees every handoff on their line
      if v_head is not null then
        for p in select id from public.profiles where role = v_head and is_active and id <> new.to_id and id is distinct from new.from_id loop
          perform private.notify(p, 'handoff', format('%s: new %s', v_client, v_seat), format('%s takes over the %s seat. The handoff and checklist are ready.', coalesce(v_to, 'Someone'), v_seat),
            format('/handoff/%s', new.id), new.client_id, format('handoff-lead:%s', new.id), 'normal');
        end loop;
      end if;
    end if;
  end if;
  return new;
end $$;

alter table public.seat_transfer_moves add column if not exists moved jsonb;
alter table public.seat_transfer_moves add column if not exists slack jsonb;

create table if not exists public.slack_seat_audits (
  id         uuid primary key default gen_random_uuid(),
  ran_at     timestamptz not null default now(),
  invited    boolean not null default false,
  report     jsonb not null default '{}'
);
create index if not exists slack_seat_audits_ran on public.slack_seat_audits (ran_at desc);
alter table public.slack_seat_audits enable row level security;

insert into public.app_settings (key, value) values ('slack_seat_sync', '{"invite": false, "removeFromExternal": true}')
on conflict (key) do nothing;
