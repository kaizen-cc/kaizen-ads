-- A go-to-market strategy built ahead of a sales call when nobody said direct or white label and nothing showed a
-- partner: built in Kaizen's branding and marked "Assumed Kaizen", so the card offers the switch (and rebuilds on it)
alter table public.prospect_gtms add column if not exists assumed boolean not null default false;
