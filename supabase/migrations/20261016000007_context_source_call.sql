-- Calls (Gemini and Fireflies notes) are a context source too
alter type public.context_source add value if not exists 'call';
