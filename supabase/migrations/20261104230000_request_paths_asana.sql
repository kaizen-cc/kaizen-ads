-- Creative requests sent to Asana from Kaizen Ads: built exactly like the Google Form's tasks on the Creative board, so
-- the creative team sees nothing different while the briefs move into Kaizen Ads.

-- The links every form-made task carries (the AI prompts per format, the checklist, the "ready for the client" form),
-- kept as a setting so they can change without a deploy
insert into public.app_settings (key, value)
values ('asana_request_template', jsonb_build_object(
  'platform', 'Meta Ads',
  'section', 'Creative Brief',
  'blocks', jsonb_build_object(
    'video', E'REQUIRED TO USE Ai Prompt for Video Script:\nhttps://docs.google.com/document/d/1Tf7Spk4R356rJ7T9iBKCbehR_CTgfzp9_uydLZSVw_0/edit?tab=t.0#heading=h.mwxshm9sxmwi\n\nREQUIRED CHECKLIST BEFORE CONTINUING:\nhttps://drive.google.com/file/d/19gKytbu3prJI2cJStXc_LNzpsRLZQV_c/view?usp=drive_link\n\nReminder on how to use the prompt:\nhttps://www.loom.com/share/d6c9613eebfa4792bea1f1967b0d9576\n\nREQUIRED TO USE Ai prompt for copywriting:\nhttps://claude.ai/project/019d263b-0d5f-763f-ac80-80bc1e36f5ca',
    'image', E'REQUIRED TO USE Ai prompt for SINGLE IMAGE creative:\nhttps://docs.google.com/document/d/13BD2kQByd0A6Ku5Tlm3NbqcWxGEHcrs20qHQL2CNUc4/edit?tab=t.0\n\nReminder on how to use the prompt: \nhttps://www.loom.com/share/d9cefdc0fd7c4ae0a7099748a42044bc\n\nREQUIRED TO USE Ai prompt for copywriting:\nhttps://claude.ai/project/019d263b-0d5f-763f-ac80-80bc1e36f5ca',
    'carousel', E'REQUIRED TO USE Ai Prompt for Carousel Creative:\nhttps://docs.google.com/document/d/1MoSncaU2Bb7ZZ7wI_vwOCpj12fS__q_3dd-sx9RbzqI/edit?tab=t.0\n\nReminder on how to use prompt: https://www.loom.com/share/21d2a6562bed4bb194016b4aae612dda\n\nREQUIRED TO USE Ai prompt for copywriting:\nhttps://claude.ai/project/019d263b-0d5f-763f-ac80-80bc1e36f5ca'
  ),
  'readyForm', 'https://docs.google.com/forms/d/e/1FAIpQLSedlc6bnn0rAhrYQlXVAoZtMDfmFf-eh7DH0jWWfv4YiRjFDA/viewform?usp=header'
))
on conflict (key) do nothing;

-- Every request sent to Asana from here: what was sent, by whom, and the tasks it made
create table if not exists public.asana_sent_requests (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  suggestion_id uuid references public.creative_suggestions(id) on delete set null,
  draft jsonb not null,
  tasks jsonb not null default '[]'::jsonb,
  origin jsonb,
  sent_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists asana_sent_requests_client on public.asana_sent_requests (client_id, created_at desc);
alter table public.asana_sent_requests enable row level security;
drop policy if exists "staff read sent asana requests" on public.asana_sent_requests;
create policy "staff read sent asana requests" on public.asana_sent_requests for select to authenticated using (private.is_staff());

-- The mirror marks tasks made from Kaizen Ads (counted once, like any Asana task; never also a ticket)
alter table public.asana_tasks add column if not exists from_kaizen_ads boolean not null default false;
alter table public.asana_tasks add column if not exists sent_request_id uuid references public.asana_sent_requests(id) on delete set null;

-- A suggested brief sent to Asana instead of the Board: its tasks
alter table public.creative_suggestions add column if not exists asana jsonb;
