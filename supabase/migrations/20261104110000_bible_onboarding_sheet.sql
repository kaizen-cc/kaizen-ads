-- From the team's Client Onboarding Sheet, only what was agreed for the Bible (Meta and Google planning goes to the
-- go-to-market strategies): features and benefits per product or service, the USP's primary promise and unique
-- mechanism, and the pop-up offer word for word. Small, targeted edits to the structure skill.
update public.ai_knowledge
set body = replace(
      replace(
        replace(
          body,
          'in plain words a copywriter can turn into a hook, e.g. "a fourth-generation wholesaler that hand-selects and cuts the fish itself, seals it and ships it to your door in three days".',
          'in plain words a copywriter can turn into a hook, e.g. "a fourth-generation wholesaler that hand-selects and cuts the fish itself, seals it and ships it to your door in three days". Then its primary promise (the one result the customer gets) and its unique mechanism (the how that makes the promise believable).'
        ),
        '- **2b. Features and benefits**: Feature (what the product or service has) · Benefit (what the customer gets from it) · Proof. 6–12 rows.',
        '- **2b. Features and benefits**, per product or service: Product or service · Details · Feature (what it has) · Benefit (what the customer gets from it) · Proof. 6–12 rows across their main products or services.'
      ),
      'the sign-up (pop-up) offer;',
      'the email or SMS sign-up (pop-up) offer, word for word as it runs on the site;'
    ),
    updated_at = now()
where id = 'c68469f0-5799-4a39-aed6-134ee1c7f1ff';

-- Each client's onboarding sheet, read once and kept until the doc changes
create table if not exists public.client_onboarding_sheets (
  client_id uuid primary key references public.clients(id) on delete cascade,
  file_id text,
  url text,
  name text,
  modified_at timestamptz,
  source text not null default 'found' check (source in ('found', 'set')),
  bible jsonb,
  meta jsonb,
  google jsonb,
  error text,
  read_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.client_onboarding_sheets enable row level security;
create policy "staff read onboarding sheets" on public.client_onboarding_sheets for select to authenticated using (private.is_staff());
