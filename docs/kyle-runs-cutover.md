# Kyle's Claude scheduled runs → Kaizen OS: cutover checklist (Nov 24 2026)

Spec: `docs/kyle-scheduled-runs.md`. Every run below is now a **routine** in Kaizen OS (`/routines`, per person,
on for Kyle at his times; execs and leads can turn theirs on). Output lives in the OS (Routines page, the bell, his
Overview items), never Slack DMs, Slack drafts or Asana tasks. Every item a routine makes goes through the **dedupe
against reality** (`src/lib/reality-check.ts`): done → not made, in motion → linked to the existing item.

**How to cut over each one:** leave the Claude run on and let both run side by side for **3 weekdays** (the Friday and
Sunday runs: one cycle). Compare the OS report on `/routines` with the Claude run's output. When the OS covers what the
Claude run caught (and nothing important is missing), pause that Claude run. Keep it paused a week, then delete it.

| # | Claude run | Kaizen OS routine | Status | Switch off after |
|---|---|---|---|---|
| 1 | Client Call Debrief (10:07, 12:07, 14:07, 16:07, 20:07) | **Call debrief sweep** (same times, weekdays) | ON | 3 weekdays matching |
| 2 | Morning Recap (8:45) | **Morning recap** | ON | 3 weekdays matching |
| 3 | Afternoon Meeting Recap (3pm) | **Afternoon meeting recap** | ON | 3 weekdays matching |
| 4 | End-of-Day Recap (6pm) | **End-of-day recap** | ON | 3 weekdays matching |
| 5 | Delegation Tracker (7:25pm) | **Delegation tracker** | ON | 3 days matching (see DMs below) |
| 6 | Nightly Execution Agent (7:48pm) | **Nightly execution agent** | ON | 3 nights matching |
| 7 | Morning Clean Sweep (7:40am) | **Morning clean sweep** | ON | 3 mornings matching |
| 8 | Friday Week Recap (Fri 4:45pm) | **Friday week recap** | ON | 1 Friday matching |
| 9 | Sunday Week-Ahead Prep (Sun 5:55pm) | **Sunday week-ahead prep** | ON | 1 Sunday matching |
| + | (new) | **Call prep** before every client/sales call, plus the existing afternoon-before integration check | ON when he turns it on | n/a |

## What to compare, and known differences

- **Debrief (1):** the OS reads the calls Kaizen already ingests from Gemini and Fireflies (matched to clients by the
  calls step). The team's commitments from client calls were already routed by the OS (promise routing); the sweep adds
  **Kyle's own action items** and **sales calls into Sales › Prospects** (structured overview: services, budget,
  objections, pricing as said, fit). Client dossiers (Slack canvases) aren't updated: the OS keeps that history on the
  client page. Unregistered-client onboarding (class C) isn't automated: those calls show as "client match incomplete"
  in the coverage list. Check: same calls found, same items for Kyle, same sales records.
- **Recaps (2-4, 8, 9):** need **Google Calendar read access** for Kyle (calendar.readonly on the Workspace's
  domain-wide delegation). Without it each recap names "Google Calendar" as a source it couldn't read, and the meeting
  sections are thin. Check that line is gone before switching off.
- **Delegation tracker (5):** reads Kyle's messages in the **internal client channels** the app is in. **DMs and group
  DMs** need Kyle to allow reading in Connections (his Slack connection can post, not read history). Until then, keep the
  Claude run on for DMs, or compare only channel asks.
- **Nightly agent (6):** drafts sit on the item and on `/routines › Ready for you` (one-tap **Send** for the client's
  internal channel, as Kyle; Copy for email and teammate DMs). PDFs save only to his standing folder **Agents › Nightly
  Agent Deliverables**. Staged team tasks wait under **Staged for your release** (Release / Not needed). It never sends,
  never touches ad or email platforms, never states a client's fee.
- **Clean sweep (7):** closes only on proof (the done-check's guardrails), merges duplicates (the oldest keeps the
  details), and lists Only you / Just hit send / Answer the agent / Release staged / Probably done.
- **Push:** the OS rings the bell (and emails a critical notice still unread after the usual delay). There's no phone
  push app; if Kyle relies on Claude's phone push for urgent debrief alerts, keep run 1 on until he's happy with the
  bell + email.
