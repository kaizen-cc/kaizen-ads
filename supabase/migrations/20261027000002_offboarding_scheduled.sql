-- Offboarding forms with a last day still ahead wait as 'scheduled' until that day
alter table public.integration_events drop constraint if exists integration_events_status_check;
alter table public.integration_events add constraint integration_events_status_check check (status in ('received', 'processed', 'failed', 'scheduled'));
