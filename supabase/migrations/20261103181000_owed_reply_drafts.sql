-- Drafted replies: for each message waiting on someone, the reply the AI drafts in their voice, kept until the
-- thread moves on (draft_basis is the last message it was written against).
alter table public.owed_replies add column if not exists draft text;
alter table public.owed_replies add column if not exists draft_basis text;
alter table public.owed_replies add column if not exists drafted_at timestamptz;

-- Links that open the exact message. A Slack reply inside a thread needs the thread in its link (without it Slack
-- opens the channel, where the reply isn't), and Gmail opens a conversation by its thread id.
update public.owed_replies
   set url = url || '?thread_ts=' || thread_ts || '&cid=' || channel_id
 where source = 'slack' and thread_ts is not null and thread_ts <> message_ts and url like 'https://slack.com/archives/%' and url not like '%thread_ts=%';
update public.owed_replies
   set url = 'https://mail.google.com/mail/u/' || mailbox || '/#all/' || gmail_thread_id
 where source = 'gmail' and gmail_thread_id is not null and mailbox is not null;
update public.message_promises
   set url = url || '?thread_ts=' || thread_ts || '&cid=' || channel_id
 where source = 'slack' and thread_ts is not null and thread_ts <> message_ts and url like 'https://slack.com/archives/%' and url not like '%thread_ts=%';
update public.message_promises
   set url = 'https://mail.google.com/mail/u/' || mailbox || '/#all/' || gmail_thread_id
 where source = 'gmail' and gmail_thread_id is not null and mailbox is not null;

-- Notifications about them carry the fixed link
update public.notifications n
   set href = o.url
  from public.owed_replies o
 where split_part(n.key, ':', 1) in ('owed', 'owed2', 'owed-lead', 'owed-done') and split_part(n.key, ':', 2) = o.id::text and o.url is not null and n.href is distinct from o.url;
update public.notifications n
   set href = p.url
  from public.message_promises p
 where split_part(n.key, ':', 1) in ('said', 'said2', 'said-lead', 'said-moving') and split_part(n.key, ':', 2) = p.id::text and p.url is not null and n.href is distinct from p.url;
