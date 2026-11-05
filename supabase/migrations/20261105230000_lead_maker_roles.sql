-- Two new positions (owner, Nov 2026): Lead graphic designer and Lead video editor. Each works exactly like their base
-- role (same team tier, formats and permissions); the only difference is that they can pick any client. The values are
-- added here on their own because a new enum value can't be used in the same transaction that adds it; the next
-- migration puts them to use.
alter type public.team_role add value if not exists 'lead_graphic_designer' after 'video_editor';
alter type public.team_role add value if not exists 'lead_video_editor' after 'lead_graphic_designer';
