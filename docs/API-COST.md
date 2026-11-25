# Claude API cost

The owner's rules (Nov 25 2026): cut Claude spend without lowering quality. The lowest model and effort that keeps
quality; **Opus only at medium effort and only for genuinely strategic thinking**; everything else Sonnet or Haiku at
the lowest effort that works. This file is the measurement, the inventory and what was changed, slice by slice.

Prices (per million tokens; platform.claude.com pricing, Nov 2026): Opus 5.5 $4 in / $20 out, Sonnet 5.5 $2 / $10,
Haiku 5.5 $0.10 / $0.50. Cache write 1.25x input for 5 minutes, 2x for 1 hour; cache read $0.20 Opus, $0.10 Sonnet,
$0.01 Haiku (0.05x-0.1x input). Minimum cacheable prefix 512 tokens on all three. Batch API: 50% off, results within
24 hours. All figures below are from `ai_runs` priced with `src/lib/ai-costs.ts` (Gemini rows, about $45 a month for
YouTube transcripts and market reads, are left out).

## 1. Where the money goes (measured Nov 25 2026)

| Window | Calls | Spend | Uncached input | Output | Cache writes | Cache reads | Cache hit | Opus share | Background (no one signed in) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Last 7 days | 16,384 | **$1,240** | $501 | $267 | $405 | $65 | 60.5% | $985 (79%) | $541 |
| Last 30 days | 42,953 | **$3,553** | $1,549 | $1,006 | $824 | $135 | 57.8% | $2,714 (76%) | $2,220 |

The run rate is rising: the last 7 days project to about **$5,300 a month** (Nov 23 $287, Nov 24 $348). Three things stand
out: Opus is four fifths of the bill, cache *writes* are a third of it (prompts written to the cache and never read back),
and Kaizen AI chats send 250k-830k tokens per message.

### By place in the app, last 7 days (top 40, about 90% of spend)

| Agent | Label | Model/effort | Calls | $ 7d | Avg tokens in | Avg out | Cache hit |
|---|---|---|---:|---:|---:|---:|---:|
| copy | Kaizen AI chat (copy, client) | opus/medium | 261 | 161.43 | 273,542 | 3,168 | 58% |
| strategist | Kaizen AI chat (strategist, client) | opus/medium | 178 | 142.79 | 449,156 | 2,101 | 65% |
| coach | assistant (agent call assistant) | sonnet | 762 | 58.18 | 166,154 | 316 | 84% |
| report_qa | channel report QA | opus/high | 386 | 44.83 | 21,656 | 3,465 | 52% |
| strategist | monthly shot list | opus/medium | 117 | 44.27 | 69,291 | 4,223 | 0% |
| report_qa | report QA | opus/high | 288 | 43.48 | 25,850 | 4,422 | 44% |
| strategist | suggestion summary | opus/medium | 120 | 38.89 | 77,216 | 1,196 | 8% |
| auditor | audit · findings | opus/high | 46 | 38.48 | 111,269 | 18,252 | 1% |
| reporter | revise channel report | opus/medium | 304 | 37.69 | 31,131 | 2,913 | 53% |
| auditor | audit · plan | opus/high | 42 | 36.70 | 118,345 | 18,644 | 1% |
| google_auditor | Kaizen AI chat (google_auditor, client) | opus/high | 33 | 36.13 | 611,943 | 6,328 | 69% |
| auditor | Kaizen AI chat (auditor, client) | opus/high | 33 | 34.64 | 831,067 | 8,744 | 80% |
| strategist | drafted brief | opus/medium | 96 | 30.67 | 69,678 | 2,614 | 10% |
| coach | assistant (agent call email_strategist) | sonnet | 472 | 30.60 | 194,079 | 398 | 90% |
| auditor | sprint check | opus/high | 240 | 28.05 | 43,341 | 2,164 | 62% |
| market | youtube transcript | gemini-flash | 647 | 23.98 | 7,235 | 406 | n/a |
| strategist | Kaizen AI chat (strategist) | opus/medium | 37 | 22.69 | 283,114 | 2,916 | 58% |
| scripts | Kaizen AI chat (scripts) | opus+sonnet/medium | 58 | 21.52 | 259,602 | 2,376 | 73% |
| reporter | revise report | opus/medium | 68 | 18.15 | 72,702 | 3,543 | 37% |
| copy | Kaizen AI chat (copy) | opus/medium | 24 | 16.55 | 371,387 | 4,635 | 67% |
| google_reporter | revise report | opus/medium | 119 | 15.72 | 37,098 | 3,027 | 56% |
| google_auditor | Kaizen AI chat (google_auditor) | opus/high | 16 | 13.28 | 383,378 | 4,266 | 60% |
| calls | draft owed reply | sonnet/low | 115 | 10.93 | 50,726 | 235 | 13% |
| reporter | weekly email report | opus/medium | 53 | 9.66 | 29,197 | 4,424 | 28% |
| calls | client email drafts | sonnet/low | 374 | 8.49 | 16,849 | 159 | 48% |
| reporter | weekly report | opus/medium | 56 | 8.44 | 25,044 | 4,960 | 54% |
| google_auditor | sprint check | opus/high | 69 | 7.49 | 28,097 | 1,648 | 41% |
| reporter | Kaizen AI chat (reporter, client) | opus/medium | 11 | 7.38 | 273,788 | 3,693 | 56% |
| coach | assistant (agent call strategist) | sonnet/medium | 105 | 7.32 | 196,187 | 518 | 89% |
| review | brief self-review | opus/medium | 22 | 7.23 | 60,058 | 5,476 | 13% |
| market | read a market ad | sonnet/low | 625 | 7.07 | 14,122 | 519 | 84% |
| google_auditor | audit · plan | opus/high | 10 | 7.04 | 90,530 | 16,550 | 2% |
| strategist | account handoff | opus/medium | 14 | 6.99 | 73,870 | 11,702 | 14% |
| google_auditor | audit · findings | opus/high | 11 | 6.92 | 83,015 | 14,267 | 2% |
| calls | routine nightly item | sonnet/medium | 92 | 6.70 | 42,683 | 990 | 29% |
| strategist | brief revise | sonnet/low | 40 | 6.47 | 76,737 | 1,185 | 8% |
| auditor | Kaizen AI chat (auditor) | opus/high | 18 | 6.03 | 183,524 | 1,516 | 67% |
| coach | agent call learnings strategist | sonnet/low | 89 | 6.02 | 34,564 | 30 | 3% |
| calls | read a doc | sonnet/low | 148 | 5.98 | 19,929 | 697 | 28% |
| strategist | asana allotment count | opus/medium | 72 | 5.92 | 20,726 | 242 | 22% |

By family, last 7 days: **Kaizen AI chat $470 (38%)**, reports + report QA $240, audits + sprint checks $135, the
assistant (chat and calls) $110, strategist background work (shot list, suggestions, drafted briefs, allotment count)
$120, reading calls/docs/messages and drafting replies $45.

Over 30 days the order differs because several jobs were already cut back before this work (Brand Bible builds $570 in
30 days but $40 in the last 7; "recheck call promises" $58 vs $1; "group promises" $53 vs $3; "loom distill" $47 vs
$0.27). Those are not counted as savings here.

## 2. Bugs that were paying for the same work again

| What | Cost | Cause | Fix |
|---|---:|---|---|
| Monthly shot list written every hour | ~$44/week (~$190/month) | The scheduled run passed a description ("Kaizen OS (each billing cycle)") into `shot_lists.created_by`, a uuid: every save failed (400), so the same client's list was written again the next hour, all day | `src/lib/shot-list.ts`: `created_by` is the person or null |
| Agent tests had nothing to replay | (quality, not cost) | `trim_agent_samples()` named its subquery `old`, which clashes with the trigger's `OLD` record: every `agent_samples` insert failed (905 a day), so Settings › AI agents tests and the drift check never had real calls | migration `20261125180000_agent_samples_trim_fix.sql` |

## 3. Models and effort: every agent

Applied in the code defaults (`DEFAULTS` in `src/lib/ai.ts`) and in Settings › AI agents (`ai_agents`), so execs can
still tune them. Opus at high is now impossible: `getAgent()` and `askJson()` cap Opus at medium whatever Settings say.

| Agent | Was | Now | Why |
|---|---|---|---|
| auditor (Meta audit, sprint checks) | opus/high | **opus/medium** | The account's strategy: stays Opus, at medium (owner's rule) |
| google_auditor | opus/high | **opus/medium** | Same |
| brandbible (the document) | opus/high | **opus/medium** | The client's strategy document; its web research already runs on Sonnet |
| gtm (go-to-market strategy) | opus/high | **opus/medium** | Strategic |
| lab (Ads Lab round table) | opus/high | **opus/medium** | Strategic; "standard" questions in the Lab now go to Sonnet (router) |
| strategist | opus/medium | opus/medium | Creative strategy from the data; its non-strategic jobs move per call site (section 3b) |
| report_qa | opus/high | **opus/medium** now; Sonnet/medium after the replay test (section 5) | A check of numbers and claims against the data |
| reporter, google_reporter | opus/medium | opus/medium until the replay test (section 5) | Client-facing writing in the buyer's voice: tested before moving |
| tiktok_auditor | opus/high | opus/medium | Offline until brought online; same rule as the other auditors |
| launcher, google_launcher, tiktok_launcher | opus/high | **sonnet/medium** | Names and settings from an approved plan by rules; pushed paused |
| review (brief self-review) | opus/medium | **sonnet/medium** | Checks a finished brief against rules |
| scripts | opus/medium | **sonnet/medium** | Writing, like the copywriter (already Sonnet) |
| creativereview | opus/medium | **sonnet/medium** | Reads the design and leaves notes; Sonnet 5.5 reads small text in images well |
| verticals (benchmarks, share lesson) | opus/medium | **sonnet/medium** | Sorting and summarizing what's known |
| email_design_brief | opus/medium | **sonnet/medium** | HTML emails on the client's brand |
| email_campaign_build, email_flow_build (Settings only) | opus/high | **sonnet/medium** | Assembling a campaign or flow from an approved plan |
| coach | opus/medium (code) | **sonnet/medium** | Talks with an agent and edits its playbooks; already ran on Sonnet in Settings |
| copy, suggest, creativecheck, calls, market, winners, industry, briefing, fatigue, email_*, social_*, tracking_*, sales_* | Sonnet or Haiku | unchanged | Already at the lowest model that fits; utility calls inside them use Haiku overrides |

Chat routing (`src/lib/ai-router.ts`, the Lab and the client portal chat): quick sonnet/low (unchanged), **standard
opus/medium → sonnet/medium**, **deep opus/high → opus/medium**.

Kaizen AI (`/ai`): new chats start on **Sonnet** ("For almost everything"); Opus stays in the picker as "For real
strategy". Every chat runs at medium at most (it ran at the agent's effort, so the auditor's chats were Opus at high).

### 3b. Not downgraded, and why

| What | Kept | Why |
|---|---|---|
| Audits' findings and plan (auditor, google_auditor) | Opus (medium) | The account strategy the buyer acts on: the one place the owner named for Opus |
| Brand Bible document, GTM strategy, Ads Lab | Opus (medium) | Strategy documents; low volume now ($40 in the last 7 days for Bibles) |
| strategist: drafted brief, refresh a tiring ad, marketing moment brief, account handoff | Opus (medium) | Creative strategy for a client. Tested next (section 5); moved only if Sonnet holds |
| The assistant (chat and calls) | Sonnet | Already Sonnet with 84-90% cache hits; Haiku is not good enough for the agent that runs the OS |
| Kaizen AI threads already on Opus | Opus (medium) | Switching an open thread's model would throw away its cache (caches are per model) and its reasoning |

## 4. Prompt caching

Before: one cache mark on each call's system prompt, with the task's own instructions *first* and the agent's spine,
core and skills after them. Every call site of an agent therefore had its own cache entry, kept five minutes, and most
background calls are more than five minutes apart: so the prompt was written again (at 1.25x) on almost every call.
That is why cache writes were a third of the bill.

Changed (`src/lib/ai.ts`, `src/lib/kaizen-ai/chat.ts`, `src/lib/agent-call/server.ts`):

1. **Agent material first, kept an hour.** `agentSystem()` sends the agent's material (spine, core, instructions,
   skills, knowledge) as its own block with a 1-hour cache mark, then the task's own instructions with a 5-minute mark.
   Every call the strategist makes, from any place in the app, now reads the same cached block for an hour.
2. **Tool loops cache as they go.** `askJsonWithTools` (audits, sprint checks and other tool-using calls) had no mark on
   the conversation, so each round paid for every earlier lookup again; and its last round dropped the tool list, which
   sits at the very start of the cached prompt, so the largest round missed the cache entirely. Now every round sets
   the moving cache mark, and the last round keeps the tools with `tool_choice: none`.
3. **Kaizen AI chat: volatile text moved after the conversation.** The date, what the message matched in knowledge and
   memory, and hints for that message were a system block *before* the conversation, so the conversation itself was
   never cached: each tool round re-sent 250k+ tokens at full price. They now ride with the newest message, the
   conversation is cached at each round (moving mark), the agent's material and the client's context are kept an hour,
   and the tool list's own mark (redundant: the system mark covers it) is gone, staying within four marks.
4. **The assistant (calls and chat)** caches the conversation at each round too (it cached only its system prompt).
5. **Web research** (`researchWeb`) sends the agent material as an hour block as well.

Cache hit rate before: 60.5% (7 days), 57.8% (30 days). After: section 7.

## 5. Quality checks before the high-volume moves

Real samples (`agent_samples`, now saving again) are replayed with the proposed model and effort and judged blind
against what the agent wrote, by the same runner as Settings › AI agents tests (`runEval`). Tests can now be queued
(`status = 'queued'`, with `proposal.labels` to pick the place in the app) and the `evals` step runs them every 30
minutes. A move is applied only where the proposed model is not clearly worse.

Results: section 7.

## 6. Scheduled AI work: cadence and cost

See section 7 (filled in with the frequency slice).

## 7. Results and commits

Filled in as each slice ships.
