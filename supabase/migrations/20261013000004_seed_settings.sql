-- Kaizen Ads — default settings and holidays (execs can change both in Admin)

-- Stage due dates, in business days (0 = end of the same business day).
-- Production: images 2 days, videos 4 days from request. Internal review next day.
-- Copy review same day. Ready for client next day. Client follow-up 2 days.
-- Client revisions 24h (1 day). Launch 24h (1 day).
insert into public.settings (key, value) values
  ('sla', '{
     "production_image_days": 2,
     "production_video_days": 4,
     "production_carousel_days": 2,
     "internal_review_days": 1,
     "copy_review_days": 0,
     "ready_for_client_days": 1,
     "client_followup_days": 2,
     "client_revision_days": 1,
     "launch_days": 1,
     "urgent_multiplier": 0.5
   }'::jsonb),
  ('client_reminders', '{"first_reminder_days": 1, "final_reminder_days": 2}'::jsonb),
  ('deliverable_counting', '{
     "new_design": 1,
     "variation": 0,
     "carousel": 1,
     "sizes_of_one_design": 1,
     "revisions": 0,
     "counted_at": "internal_review"
   }'::jsonb),
  ('business_hours', '{"timezone": "America/New_York", "open": "08:00", "close": "18:00", "days": [1,2,3,4,5]}'::jsonb);

-- US holidays Kaizen is assumed to observe — confirm or edit in Admin
insert into public.holidays (day, name) values
  ('2026-11-26', 'Thanksgiving'),
  ('2026-11-27', 'Day after Thanksgiving'),
  ('2026-12-24', 'Christmas Eve'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-31', 'New Year''s Eve'),
  ('2027-01-01', 'New Year''s Day'),
  ('2027-05-31', 'Memorial Day'),
  ('2027-07-05', 'Independence Day (observed)'),
  ('2027-09-06', 'Labor Day'),
  ('2027-11-25', 'Thanksgiving'),
  ('2027-11-26', 'Day after Thanksgiving'),
  ('2027-12-24', 'Christmas Day (observed)'),
  ('2027-12-31', 'New Year''s Day (observed)');
