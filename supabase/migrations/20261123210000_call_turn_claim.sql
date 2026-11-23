-- One utterance, answered once: each turn claims its words on the conversation when it starts (a fingerprint and when),
-- in one conditional update, so the same words arriving twice at once (the transcriber sending a turn twice, a double
-- send) are answered by the first only, on any server. Nov 23 2026: "Did you finish that?" was answered twice.
alter table public.ai_role_calls add column if not exists last_said_key text;
alter table public.ai_role_calls add column if not exists last_said_at timestamptz;
