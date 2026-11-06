-- "Want me to suggest some more changes while you have me here?" after a launch from the client chat is deployed
-- (src/lib/launch-more.ts): when the account has an optimization sprint, the suggestions the buyer says yes to go on
-- its action list, tagged as from the launch chat. Until this runs they're added as the buyer's own moves instead
-- (source 'buyer', with a note saying where they came from), so nothing waits on it.

alter table public.sprint_actions drop constraint if exists sprint_actions_source_check;
alter table public.sprint_actions add constraint sprint_actions_source_check check (source in ('audit', 'buyer', 'business_audit', 'launch'));
