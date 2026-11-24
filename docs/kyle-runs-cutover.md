# Kyle's Claude scheduled runs → Kaizen OS: cutover checklist (Nov 24 2026)

Spec: `docs/kyle-scheduled-runs.md`. Every run below is now **baked into Kaizen OS for everyone** (owner, Nov 24:
no page, no settings): each active team member gets it at the standard times in their own time zone, scoped to what
their role has, and a run with nothing to say is skipped. Output goes where people already look: the recap leads their
day (the recap deck and the Your day hero), items land in Needs me, drafts sit on the items, team tasks are their own
item to hand off with Delegate, the run's top line rings the bell. Their assistant runs any of them on demand ("give me
my end-of-day recap", "prep me for my 2pm") and changes their times if they ask ("send my recap at 9"). Never Slack
DMs, Slack drafts or Asana tasks. Every item a routine makes goes through the **dedupe
against reality** (`src/lib/reality-check.ts`): done → not made, in motion → linked to the existing item.

**How to cut over each one:** leave the Claude run on and let both run side by side for **3 weekdays** (the Friday and
Sunday runs: one cycle). Compare what lands in Kyle's day (or ask his assistant "what did my morning recap say") with the Claude run's output. When the OS covers what the
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
| + | (new) | **Call prep** before every client call (sales calls: the Sales agent's briefs), plus the existing afternoon-before integration check | ON for everyone | n/a |

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
- **Nightly agent (6):** each drafted message sits on its item (in the item's notes, ready to copy, or his assistant
  sends it on his yes). PDFs save only to his standing folder **Agents › Nightly Agent Deliverables**. Team tasks become
  his own "Hand to <person>" items, handed on with the usual Delegate. It never sends, never touches ad or email
  platforms, never states a client's fee.
- **Clean sweep (7):** closes only on proof (the done-check's guardrails), merges duplicates (the oldest keeps the
  details), and lists Only you / Just hit send / Answer the agent / Hand off / Probably done.
- **Push:** the OS rings the bell (and emails a critical notice still unread after the usual delay). There's no phone
  push app; if Kyle relies on Claude's phone push for urgent debrief alerts, keep run 1 on until he's happy with the
  bell + email.
