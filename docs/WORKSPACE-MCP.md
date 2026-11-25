# Google Workspace: MCP for agents, REST for syncs

_Nov 24 2026. Why: Google's email to the owner about project `atomic-athlete-510921-h2`, and the Workspace AI Tools Addendum._

## What Google changed

| Date | What |
|---|---|
| Nov 24 2026 | Standard and Scaled usage tiers launch. Standard is free and the default, with no quota increases. Scaled needs a linked billing account and is opted into per project. [B] |
| Nov 24 2026 | Workspace AI Tools Addendum published. [D] |
| Feb 1 2027 | The Addendum takes effect and technical enforcement begins: AI agents must reach Workspace data through Google's MCP servers. [B][C] |
| Apr 1 2027 | Limits are enforced and Scaled billing starts. Gmail, Calendar and Drive MCP on Scaled have no free allowance. [B] |

**The rule.** "The GWS Access Tool must use a Google MCP" whenever the tool is, or is driven by, an AI Agent, AI Harness or AI model [D]. The Addendum defines an AI Agent as "goal-oriented artificial intelligence (AI) systems or workflows that perform actions or tasks" [D]. An agent that keeps calling REST anyway is held to Standard-tier quotas, whatever tier the project is on [B][E].

**Retention and use [D][F].**
- No keeping user data obtained through an access tool, including after access is revoked.
- No processing beyond "active, user-authorized tasks".
- No training, fine-tuning or distillation on that data.
- No scraping or systematic probing.
- Google Technical Information is kept 30 days at most.
- The User Data policy also rules out "permanent copies" and databases of user data [F].

**Standard tier [B].**
- REST keeps its long-standing per-project quotas. Gmail's is 1.2M quota units a minute, roughly 240k reads a minute.
- Google's GA MCP servers are capped at **5,000 requests a day per product per project**, plus per-minute limits. Some tools count as more than one request.

Sources:
- [A] https://developers.google.com/workspace/guides/configure-mcp-servers
- [B] https://developers.google.com/workspace/guides/quota-usage-tiers
- [C] https://workspaceupdates.googleblog.com/2026/11/mcp-servers-cli-standardized-usage-tiers-now-available.html
- [D] https://workspace.google.com/terms/ai-tools
- [E] https://developers.google.com/workspace/tools-safety
- [F] https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- [H] https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server

The full research notes, with every finding marked verified or not found, are in the session notes `workspace-mcp-research.md`.

## Google's MCP servers [A]

| Server | Endpoint | Tools |
|---|---|---|
| Gmail | `https://gmailmcp.googleapis.com/mcp/v1` | search_threads, get_thread, get_message, list_drafts, list_labels, create_draft, label/unlabel_message, label/unlabel_thread. **No send, no attachments.** |
| Drive | `https://drivemcp.googleapis.com/mcp/v1` | search_files, list_recent_files, get_file_metadata, get_file_permissions, read_file_content, download_file_content, create_file, copy_file |
| Calendar | `https://calendarmcp.googleapis.com/mcp/v1` | list_events, get_event, list_calendars, search_events, suggest_time, create/update/delete_event, respond_to_event |
| Docs | `https://docsmcp.googleapis.com/mcp/v1` | read_doc, update_doc |
| Sheets | `https://sheetsmcp.googleapis.com/mcp/v1` | get_values, get_spreadsheet, update_spreadsheet, update_values, update_formulas, insert_dimension |
| Slides | `https://slidesmcp.googleapis.com/mcp/v1` | read_presentation, read_slide_page, read_slide_page_thumbnail, update_presentation |

- **Transport.** Streamable HTTP.
- **Scopes.** The same OAuth scopes as REST, with no MCP-specific scopes.
- **OAuth clients.** An OAuth client used by an agent must be flagged "Use this client for an AI-powered agent". **Service accounts with domain-wide delegation skip that setting** [A]. That is how Kaizen OS reads Workspace today, so no new OAuth client or consent screen is needed.
- **Status.** Google's pages disagree. The configure page still says Developer Preview; the tiers page (Nov 24) calls these servers GA. The check below settles it for our project.

## How Kaizen OS reaches Workspace

Every Workspace call uses the Workspace service account (`GOOGLE_SERVICE_ACCOUNT_JSON`) with domain-wide delegation, acting as the person. There is no per-person OAuth and no Calendar access today.

### Must move to MCP (an AI agent decides what to read or write)

| Tool (name unchanged) | Where | Before | Now |
|---|---|---|---|
| `search_my_email` | lib/assistant/lookup-tools.ts | Gmail REST messages.list/get | Gmail MCP `search_threads` |
| `read_my_email_thread` | lib/assistant/lookup-tools.ts | Gmail REST threads.get | Gmail MCP `get_thread`. Attachments (pictures shown to the model, every file named) still REST: Gmail MCP has no attachments (lib/context/google.ts `threadAttachments`). |
| `save_draft` and every agent-made Gmail draft | lib/assistant/platform-drafts.ts | Gmail REST drafts.create | Gmail MCP `create_draft`, with the same plain and HTML bodies as REST (`emailBodies`: real links, their Gmail signature). REST when the draft has files, is a reply in a thread, or needs HTML that Google's `create_draft` doesn't take. |
| `edit_google_doc` (Kaizen AI and the assistant) | lib/docs-edit.ts, lib/docs-edit-core.ts | (new) | Docs MCP `read_doc` / `update_doc` with batchUpdate requests, as the person. REST when the MCP answers without the doc's structure. Each edit is shown first and runs only on their yes. |
| `read_google_file` (Kaizen AI, assistant) and the SOW reader | lib/assistant/read-file.ts | Drive REST files.get/export | Drive MCP `get_file_metadata` and `read_file_content` |
| `search_my_gmail` / `read_gmail_thread` (Kaizen AI) | lib/kaizen-ai/workspace-tools.ts | Gmail REST | Gmail MCP `search_threads` / `get_thread`; a thread's attachments still REST (no attachments in Gmail MCP) |
| `search_my_drive` (Kaizen AI) | lib/kaizen-ai/workspace-tools.ts | Drive REST files.list | Drive MCP `search_files` |
| `my_calendar` (Kaizen AI) | lib/kaizen-ai/workspace-tools.ts | Calendar REST events.list | Calendar MCP `list_events` |
| `find_meeting_time`, `book_meeting`, `reschedule_meeting`, `cancel_meeting` | lib/assistant/calendar-tools.ts, calendar-server.ts | Calendar REST freeBusy + events | Still REST. Next slice: Calendar MCP `suggest_time`, `create_event`, `update_event`, `delete_event`. Free/busy across teammates may not map one to one, so check with the check route first. |
| `send_message` (email, on a spoken yes) | lib/assistant/comms-tools.ts | Gmail REST messages.send | **Still REST. Gmail MCP has no send.** Needs your decision (below). |
| `export_to_google_doc` / `export_to_google_sheet` | lib/kaizen-ai/tools.ts | Drive REST multipart upload | Still REST. Next slice: Drive MCP `create_file` |
| `fill_recap_deck` | lib/ai-tools/recap-deck.ts | Drive copy + Slides batchUpdate | Still REST. Next slice: Drive `copy_file` + Slides `update_presentation` |
| `read_report_sheet` | lib/ai-tools/team-ops.ts | Drive export | Still REST. Next slice: Sheets `get_values` |

Agents and routines' agent steps reach Workspace only through these tools, so the list covers chat, calls, Kaizen AI, the role agents and routines.

**Our own MCP client, not the Messages API connector.** Our server calls Google's MCP servers itself (lib/workspace-mcp.ts, which speaks JSON-RPC over Streamable HTTP) rather than handing the servers to Anthropic's MCP connector. Three reasons:

1. The person's Google token never leaves our server.
2. The tools keep their names, answers and our rules on top: drafts not sends unless they say yes, Drive saves confirm the folder, view-as stays read only, people matters stay private.
3. Chat and calls share one path.

It is still Google's MCP server doing the Workspace access, which is what the Addendum requires.

### May stay on REST (deterministic syncs, no model choosing what to fetch)

| Sync | What it reads |
|---|---|
| `context?step=gmail` (lib/context/google.ts) | Each mailbox's client mail into `context_items` |
| `context?step=drive`, `docs` (lib/context/docs.ts), lib/calls.ts | Client Drive folders; Gemini notes from Drive |
| `owed` (lib/owed-replies.ts), message promises | Unanswered emails; sent-mail checks |
| Creative Drive copy, launch sheet, onboarding, ops and account sheets, copy docs, references | Fixed files by ID |

The Addendum's MCP rule covers a tool that "is, or is driven by" an AI agent [D], and it never mentions REST for non-AI code. That makes these syncs look allowed, but it is our reading, not something Google says outright. **Grey zone:** a sync whose output is later given to a model (Brand Bible, briefs, owed-reply drafts) could be read as part of an AI harness. That needs a legal read before Feb 1. If it comes back strict, the syncs can move to the same client. The 5,000-a-day MCP cap is then the constraint, see Usage.

## Switching it on

The flag is `WORKSPACE_MCP` in Vercel:
- `off` (default): REST, as before.
- `on`: MCP first, REST if the MCP call fails. Each fallback is logged as `[workspace-mcp] … fell back to REST`.
- `only`: MCP alone.

Order:
1. Do the console steps below.
2. Open `/api/workspace-mcp/check` while signed in as an exec. Each server should answer `ok: true` with its tools. Check that the argument names match what lib/workspace-agent.ts sends; it already matches common names against the tool's schema.
3. Set `WORKSPACE_MCP=on` and watch the logs and Settings › Calls & usage for a few days.
4. Set `WORKSPACE_MCP=only`, then remove the REST branches from the agent tools before Feb 1 2027.

### Console steps (project `atomic-athlete-510921-h2`, signed in as the Kaizen Google admin)

1. **Cloud console › APIs & Services › Library.** Enable each MCP service: Gmail MCP API, Google Drive MCP API, Google Calendar MCP API, Google Docs MCP API, Google Sheets MCP API, Google Slides MCP API. The REST APIs already on (Gmail, Drive, Slides, Sheets, Admin SDK) stay on. From Cloud Shell, the same thing:
   ```
   gcloud services enable gmailmcp.googleapis.com drivemcp.googleapis.com calendarmcp.googleapis.com docsmcp.googleapis.com sheetsmcp.googleapis.com slidesmcp.googleapis.com --project=atomic-athlete-510921-h2
   ```
2. **If Google still asks for it:** join the Google Workspace Developer Preview Program [A].
3. **Admin console › Security › Access and data control › API controls › Domain-wide delegation.** On the Kaizen service account's client ID, keep the existing scopes. Add these if they're missing:
   - `https://www.googleapis.com/auth/gmail.compose` (agent drafts)
   - `https://www.googleapis.com/auth/calendar.events.readonly` and `https://www.googleapis.com/auth/calendar.calendarlist.readonly` (only if we add Calendar)
4. **Admin console › Security › API controls.** If an "MCP servers / AI tools" control appears there (Google is rolling it out over about two weeks from Nov 24 [C]), allow it for Kaizen's service account.
5. **Cloud console › APIs & Services › Workspace usage tiers dashboard.** Stay on **Standard** for now (see Usage).

## Data retention (Addendum: keep only what the task needs)

What we store from Workspace:

| Where | What | Volume (Nov 24) | Used by |
|---|---|---|---|
| `context_items` source `gmail` | Each client email: sender, date, subject, link, **body** | 65k rows, 102 MB of bodies | Brand Bible (last 500, 700 chars each), playbook rules (500 chars), briefs (400), direction changes (2,500, recent only), email ops (500), SOW finder (full, last 400) |
| `context_items` source `drive` | File names and links in client folders | 11.5k rows, 0.4 MB | Client context |
| `owed_replies` (gmail) | Unanswered email: gist, subject, **body copy**, drafted reply | 2.5k rows | Waiting on us, drafts |
| Gemini notes (lib/calls.ts) → `context_items` source `call` | Meeting note text | 5k rows | Calls, recaps |
| `drive_docs`, `client_drive_folders`, `creative_drive_files` | IDs, names, links | small | Pointers only |

What runs now (cron `context?step=workspace_retention`, daily at 07:05 UTC, function `trim_workspace_bodies`):
- **Email bodies past 90 days** (`GMAIL_BODY_KEEP_DAYS`, minimum 14) are cut to their first 600 characters, with `meta.trimmed = true`. Every reader of old email already reads 700 characters or fewer, except the SOW finder.
- **Owed replies answered or dismissed over 30 days ago** lose their copied body and drafted reply. The gist, sender, subject and dates stay.
- Nothing is deleted. Counts, history and links read the same. The oldest email today is from Oct 14, so the first trims start around Jan 12 2027.

Proposed, needs your decision:
- A shorter window (30 days) for raw email bodies, if the legal read says derived copies count as "retained user data".
- Gemini meeting notes: same window or keep whole. Client knowledge is never archived, and the notes feed Brand Bibles.
- Disconnect handling: when someone leaves (their mailbox is removed), delete their mailbox's rows. The Addendum forbids keeping data after access is revoked.

## Usage and Standard vs Scaled

Every request to a Workspace API is now counted: per New York day, per API, and per path (REST or MCP). lib/google-usage.ts listens on Node's fetch diagnostics channel, writes the counts to `google_api_usage`, and shows them in **Settings › Agents › Calls & usage** against the 5,000-a-day MCP cap.

Estimate before counting (35 active staff):
- **REST syncs.** Gmail runs every 30 minutes over every mailbox: a list per mailbox plus reads of new mail. Owed replies run every 15 minutes on weekdays. Drive and Docs run every 30 minutes. That's on the order of 10–50k Gmail reads a day and a few thousand Drive calls, far under REST's per-minute quotas.
- **Agent MCP.** About 35 people × about 10 Workspace tool calls a day ≈ 350 tool calls. With sessions kept for 10 minutes, that's about 1 initialize per person per server plus each call: **about 500–1,000 MCP requests a day per product, under the 5,000 cap.**

**Recommendation:** stay on **Standard**. Look again when the Calls & usage panel shows an MCP product's busiest day above about 2,500, or if the syncs ever have to move to MCP. Gmail sync alone would exceed 5,000 a day, and on Scaled there's no free MCP allowance [B]. Scaled can be switched on later from the tiers dashboard; opting out takes 24 hours [B].

## Decisions for the owner

1. **Agent email sends.** Gmail MCP has no send. Either:
   - (a) on a yes, the agent makes the draft through MCP and the person taps Send (in Gmail, or one tap in Kaizen OS that sends that draft as a plain user action); or
   - (b) keep REST send and accept the risk.

   Recommendation: (a).
2. **Legal read** of the Addendum on (i) syncs whose data later reaches a model and (ii) whether stored gists or bodies are "retained user data".
3. **Retention windows:** 90 days for email bodies (now) vs 30; Gemini notes.
4. **Calendar** for agents: none today. Add read-only Calendar MCP tools, or not?
