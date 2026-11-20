-- The support positions (owner, Nov 20 2026): Customer Success Coordinator (customer_success), Onboarding Specialist
-- and Tracking Specialist. They see every client with its services, like the execs, without running audits or
-- changing setup. (The enum values are added on their own: Postgres can't use a new value in the same transaction.)
alter type public.team_role add value if not exists 'onboarding_specialist';
alter type public.team_role add value if not exists 'tracking_specialist';
