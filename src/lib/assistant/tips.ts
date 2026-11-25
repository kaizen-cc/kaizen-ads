// "Did you know" tips in the assistant's hello. Each tip covers some of the assistant's real tools: it's offered only
// when the person has those tools (recorded from their own calls) and hasn't used any of them, or not for a while.
// Every tool the assistant carries is either covered by a tip or listed in NO_TIP (a test checks it), so a new
// capability can't ship without the team hearing about it. Pure, so the hello, the recorder and the tests share it.

export type Tip = { key: string; text: string; tools: readonly string[] };

export const TIPS: readonly Tip[] = [
  { key: "drafts", tools: ["draft_message", "save_draft", "my_email_drafts", "draft_promise_update", "find_email_address"], text: "you can have me draft Slack and email messages in your voice? I'll leave them as drafts for you to check and send." },
  { key: "send", tools: ["send_message"], text: "once you've okayed a reply, I can send it on Slack or email for you, straight from our chat?" },
  { key: "search", tools: ["search_my_slack", "search_my_email", "search_my_gmail", "read_my_slack_thread", "read_my_email_thread", "read_gmail_thread", "read_waiting_message"], text: "I can dig through your Slack and email for you? Ask what a client said about something and I'll find the thread." },
  { key: "teammate", tools: ["send_to_teammate", "ask_teammate", "sent_by_me"], text: "I can send a teammate a reminder or a checklist for you? They tick it off on their end and you see how far they've got." },
  { key: "remind", tools: ["remind_me", "keep_for_later"], text: "you can just say \"remind me to…\" and I'll put it on your list for the right day?" },
  { key: "plate", tools: ["my_work", "my_day", "day_item_action", "clear_my_item"], text: "you can ask me \"what's on my plate?\" and I'll go through it critical first, and mark things done or snooze them for you?" },
  { key: "comments", tools: ["item_comments", "comment_on_item"], text: "you can have me leave a comment on any item, like \"waiting on the client's answer\"? Everyone it reaches sees it, and the reminders pause." },
  { key: "promises", tools: ["my_promises"], text: "I keep track of what you've promised clients? Ask me what you owe anyone and I'll list it with the dates." },
  { key: "routines", tools: ["run_routine", "set_routine"], text: "Your recaps land in your day on their own. Say \"give me my end-of-day recap now\" or \"prep me for my 2pm\" and I'll run it right then." },
  { key: "done-check", tools: ["check_if_done", "reopen_checked_item"], text: "Say \"check if my replies and promises are done\" and I'll read Slack, email and call notes right now, close what's finished and show you the proof." },
  { key: "memory", tools: ["remember", "forget", "set_style", "update_my_profile"], text: "you can tell me how you like your answers, short or detailed, or things to remember about you? I'll keep it in mind every time." },
  { key: "settings", tools: ["update_assistant_settings", "urgent_call_settings"], text: "I can check in with you at set times, like a midday or 3pm recap, and you can choose when I call you about urgent things? Just tell me." },
  { key: "screens", tools: ["open_screen", "show_link", "look_at_screen"], text: "you can ask me to open any screen in Kaizen OS, or ask about what you're looking at? I'll take you there or explain it." },
  { key: "clients", tools: ["get_client_context", "search_client", "list_clients", "what_changed", "package_details"], text: "you can ask me about any client: how they're doing, what's due, what changed since last week? I'll pull it together in seconds." },
  { key: "numbers", tools: ["account_metrics", "kpi_board", "meta_history", "top_ads", "winners_and_fatigue", "rank_clients"], text: "you can ask me for any account's numbers, the winning ads, what's fatiguing, or which clients are doing best and worst? I'll show you." },
  { key: "email_numbers", tools: ["email_marketing", "email_detail", "klaviyo_account", "top_emails"], text: "you can ask me how a client's emails are doing: revenue, open and click rates, the best emails and flows?" },
  { key: "social_numbers", tools: ["organic_social", "social_score", "top_posts"], text: "you can ask me how a client's social is doing: reach, engagement, followers and the top posts?" },
  { key: "audits", tools: ["run_audit", "run_social_audit"], text: "you can ask me to run an audit on an account? I'll go through it and tell you what to fix first." },
  { key: "sprints", tools: ["start_sprint", "start_social_sprint"], text: "you can start an optimization sprint on an account just by asking me? I'll set it up with the plan." },
  { key: "ad_changes", tools: ["plan_ad_changes"], text: "you can tell me the budget or ad changes you want and I'll plan them for you to approve before anything goes live?" },
  { key: "launch", tools: ["launch_sheet", "launch_reply", "ticket_launch", "confirm_launch"], text: "you can launch ads through me? I'll build the launch plan with you and nothing goes live until you confirm." },
  { key: "copy", tools: ["write_ad_copy", "ticket_copy", "create_copy_doc", "approve_copy_doc", "add_copy_to_google_doc", "check_email_folders", "get_copy_library"], text: "I can write ad copy for a ticket or a whole copy doc, using the copy that's worked for that client before, type it straight into your Google Doc, and check their copy is filed in the right Drive folder?" },
  { key: "gdoc_edit", tools: ["edit_google_doc"], text: "I can edit your Google Docs for you? Change wording everywhere it appears, add under a heading or a whole new section. I'll show you the change first." },
  { key: "execview", tools: ["exec_overview", "exec_escalation_action"], text: "I can read your Overview tab by tab (what needs you, what's escalated, what's on fire) and nudge a lead or take stuck work over for you?" },
  { key: "autoclose", tools: ["auto_closed", "reopen_auto_closed"], text: "things on your day close themselves when Slack, email or call notes show they're done? Ask me why one closed, or tell me to reopen it." },
  { key: "asana", tools: ["my_asana_tasks", "update_asana_task"], text: "you can ask me what's next on your Asana, or have me move a task's due date, tick it off or comment on it, straight in Asana?" },
  { key: "support", tools: ["support_board", "tracking_health"], text: "you can ask me which reports haven't gone out, which client channels are waiting on us, or which onboardings are blocked?" },
  { key: "bell", tools: ["my_notifications", "mark_notification"], text: "I can read you what's new in your notifications, and mark one unread so it waits for later?" },
  { key: "bible", tools: ["suggest_bible_change", "bible_changes", "decide_bible_change"], text: "you can tell me what's off in a client's Brand Bible and I'll send it as a suggested change for a lead to approve? Nothing changes until they do." },
  { key: "briefs", tools: ["create_brief", "ready_briefs", "approve_brief", "reject_brief", "my_unfinished_briefs", "discard_unfinished_brief", "creative_allotments", "creative_assessment", "brief_asset_waivers", "waive_brief_asset", "rate_drafted_brief"], text: "you can write, approve or send back creative briefs with me, and ask how each client's creative allotment is pacing?" },
  { key: "tickets", tools: ["move_ticket"], text: "you can have me move a ticket to its next stage on the board? Just tell me which one and where." },
  { key: "reports", tools: ["create_report", "draft_weekly_report", "custom_report_data", "report_style", "set_report_recipients", "edit_report_message"], text: "you can build a client report just by asking me? I'll draft it in the Kaizen style, compare offers or before and after a change, rewrite its message right in the report, and remember who the email goes to." },
  { key: "documents", tools: ["make_document", "move_document", "create_document", "rate_card", "set_rate_card", "make_deck", "export_to_google_doc", "export_to_google_sheet", "deliverable", "create_case_study", "upload_to_drive"], text: "I can make a proposal deck, a project quote or a Scope of Work in Kaizen's style as a Google file, filed in the client's Headquarters, or turn anything we work on into a deck, a case study, or a Google Doc or Sheet?" },
  { key: "growth", tools: ["upsell_opportunities", "client_wins", "draft_client_emails"], text: "I can find clients ready for another service and wins worth sharing, then draft the emails for you to send?" },
  { key: "files", tools: ["read_google_file", "search_my_drive", "read_figma", "read_asana_task", "search_asana", "read_upload", "read_uploads", "read_pasted_text", "ask_for_files"], text: "you can paste a screenshot straight into our chat, or share a file, a Drive or Figma link, or an Asana task, and I'll look at it and work from it?" },
  { key: "kaizen_ai", tools: ["read_my_kaizen_ai", "search_my_kaizen_ai"], text: "I can pick up anything you worked on in Kaizen AI, so you don't have to explain it twice?" },
  { key: "calendar", tools: ["my_calendar"], text: "you can ask me what's on your calendar today or this week?" },
  { key: "schedule", tools: ["find_meeting_time", "book_meeting", "reschedule_meeting", "cancel_meeting"], text: "you can schedule calls with teammates through me? I'll check when you're both free, find the best time and send the invite." },
  { key: "specialists", tools: ["call_in_specialist", "hand_off", "start_job", "check_job", "update_job", "finish_job", "dismiss_specialist"], text: "I can bring a specialist onto our call, like the Media Buyer or the Email Strategist, to work on something with us?" },
  { key: "team", tools: ["team_kpis", "team_nudges", "send_team_nudge", "my_team_work"], text: "you can ask me how your team's doing on their KPIs, and who has something stuck, with a nudge drafted for each?" },
  { key: "phone_alerts", tools: ["phone_alerts"], text: "I can call your phone when something urgent for you sits unseen? Turn on Phone alerts in Settings, and ask me for a test call." },
  { key: "calls_usage", tools: ["calls_and_usage"], text: "you can ask me who uses the agents most and what it's costing this month, or which calls the safety review flagged?" },
  { key: "role_views", tools: ["what_role_sees"], text: "you can ask me what any role or teammate sees in Kaizen OS?" },
  { key: "handoffs", tools: ["find_person_accounts", "plan_account_transfer"], text: "when someone's accounts need to move, you can just ask me? I'll plan every seat and write a handoff for the new person." },
  { key: "review", tools: ["account_review", "review_item", "assign_review_todo"], text: "I can run the weekly account review with you step by step, and capture each decision as a to-do?" },
  { key: "risk", tools: ["flag_client_risk"], text: "if you think a client might leave, you can tell me and I'll flag it to the right people right away?" },
  { key: "feedback", tools: ["submit_feedback"], text: "if something in Kaizen OS isn't working or could be better, you can tell me and I'll file it for you?" },
  { key: "after_call", tools: ["run_after_call"], text: "you can hand me a list of long jobs, like case studies for several clients, and hang up? I keep working after the call and tell you as each one is ready." },
  { key: "layout", tools: ["overview_layout"], text: "you can switch your Overview to a simple list view just by asking me?" },
];

/** Tools that run behind the scenes and aren't worth a tip on their own */
export const NO_TIP: ReadonlySet<string> = new Set(["switch_mode", "confirm_connector_action", "connect_account"]);

const TIP_OF = new Map(TIPS.flatMap((t) => t.tools.map((name) => [name, t.key] as const)));
/** The tip a tool belongs to (null for behind-the-scenes and outside tools) */
export const tipOfTool = (name: string): string | null => TIP_OF.get(name) ?? null;
/** The tips a set of tools makes possible */
export const tipsFor = (names: readonly string[]): string[] => [...new Set(names.map(tipOfTool).filter((k): k is string => Boolean(k)))];

export type TipRow = { tip: string; seen_at: string; used_at: string | null; tipped_at: string | null };

const DAY = 86_400_000;
/** Not used for this long counts as "a while" */
export const STALE_DAYS = 30;
/** The same tip isn't offered again within this long */
export const RETIP_DAYS = 10;
/** A tool not seen on their calls for this long is no longer theirs (a role change) */
const SEEN_DAYS = 14;

/**
 * About one hello in two, a tip for something they can do but never have (first), or haven't for a while; never one
 * offered in the last few days. Picked by the call's seed so it shuffles.
 */
export function pickTip(rows: readonly TipRow[], seed: number, now = Date.now()): Tip | null {
  if (Math.abs(seed) % 2 !== 0) return null;
  const ago = (iso: string | null) => (iso ? (now - Date.parse(iso)) / DAY : Infinity);
  const open = rows.filter((r) => ago(r.seen_at) <= SEEN_DAYS && ago(r.used_at) >= STALE_DAYS && ago(r.tipped_at) >= RETIP_DAYS);
  const never = open.filter((r) => !r.used_at);
  const pool = (never.length ? never : open).map((r) => TIPS.find((t) => t.key === r.tip)).filter((t): t is Tip => Boolean(t));
  return pool.length ? pool[Math.abs(seed >> 4) % pool.length] : null;
}
