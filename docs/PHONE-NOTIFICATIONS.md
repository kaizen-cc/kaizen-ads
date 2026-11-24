# Phone-call notifications for urgent items (research, not built)

Asked for on the owner's Nov 24 2026 call with the execs: when something is on fire (a client about to leave, an ad
account down, spend running away), the agent calls the person's phone instead of waiting for them to open the app.
This is research only. Nothing below is built.

## What exists today

- **Urgent items** are `notifications` rows with `priority: "critical"`. They come from the auto audits, a client on
  fire, safety alerts and similar, and show in the bell, on the Overview, and by email.
- **The call pipeline** runs in the browser: the microphone streams to ElevenLabs realtime speech-to-text, each turn
  goes to `/api/agent-call/turn` (Claude, streamed, with the person's own tools and access), and the answer is spoken
  with ElevenLabs text-to-speech. Calls are recorded, get the safety review, and leave notes and tasks.
- **There's no phone channel**: nothing can ring a phone today.

## Options

| | How | Fits our pipeline | Effort |
|---|---|---|---|
| **A. Twilio, a short spoken notice** (recommended first) | Twilio places the call. TwiML `<Say>` reads a two-sentence summary, then `<Gather>`: "Press 1 to hear more, 2 to snooze an hour." The answer is posted back to us and marks the item seen or snoozed. | Doesn't need it. The full conversation happens in the app afterwards (the notice says "open Kaizen OS and your assistant has the details"). | Small: one API route, one webhook, a number. |
| **B. Twilio + an ElevenLabs agent** (a real conversation) | ElevenLabs Agents' native Twilio integration: `POST /v1/convai/twilio/outbound-call` with the agent, our imported Twilio number and the person's number. The agent can use a custom LLM endpoint, which we'd point at a phone variant of the assistant's turn route. | Partly. Same voice, same Claude brain, same tools if the custom LLM endpoint calls our pipeline. Speech-to-text and turn taking are ElevenLabs' rather than ours. | Medium: an OpenAI-compatible endpoint wrapping the turn route, auth per call, the transcript saved into `ai_role_chats` so the safety review and notes still run. |
| **C. Twilio Media Streams into our own engine** | Twilio streams the call's audio over a WebSocket to a small bridge that does what the browser engine does (speech-to-text, turn taking, text-to-speech) and calls `/api/agent-call/turn`. | Fully: one pipeline for app calls and phone calls, as the call/chat parity rule wants. | Large: a long-lived WebSocket service (Vercel functions aren't built for that, so it would live on Fly.io or Cloud Run), plus porting the engine's turn taking off the browser. |
| **Google Voice** | Not possible. Google Voice has no public API for placing calls (only admin provisioning of users and numbers). | n/a | n/a |

**Recommendation:** start with **A**: cheap, safe, and useful within a day. Move to **B** if people want to talk the fire
through on the phone; keep **C** for later, when phone calls are common enough to need the same engine as the app.

## Cost

Twilio US rates; check the console before building:

- About **$0.014 a minute** for an outbound call within the US and Canada (one Twilio page lists $0.022; confirm
  which applies). Inbound is about $0.0085 a minute.
- **$1.15 a month** for a local number ($2.15 toll-free). Emergency calling isn't needed for an outbound-only notice
  number.
- **Example:** 60 fire calls a month at about a minute each costs about $0.84 in minutes plus $1.15 for the number, so
  under **$3 a month** for option A.
- Option B adds ElevenLabs Agents minutes on top. Those count against the plan's conversational minutes; check our
  plan's included minutes and overage price. Claude tokens are the same as an app call of the same length.

## Consent and rules (internal staff only)

- **Opt in, per person.** A setting on their profile (and an assistant tool, so it can be turned on from a chat): their
  mobile number, verified by a code, and an explicit "call me for urgent items" switch. Off by default. Never a client,
  never a number nobody verified.
- **AI voices count as artificial voices under US calling rules** (the FCC's 2024 ruling). Calling someone's mobile
  with one needs their prior express consent. The opt-in above is that consent: keep when and how it was given, and
  stop at once when they turn it off. Contractors and staff outside the US: check local rules before switching it on
  for them.
- **Quiet hours** in the person's own time zone (say 9pm to 7am) unless they choose "even at night for client-on-fire
  items". At most one call per item and two an hour; anything else waits for the app and email.
- **The same notice as app calls** at the start of an AI conversation (option B): it's recorded and may be reviewed. The
  safety review runs on it like any call.
- **Caller ID:** register the number's name as "Kaizen OS" and keep the number on a verified Twilio account (STIR/SHAKEN
  attestation), so it doesn't show up as spam.

## How it plugs in

1. **Who gets a call.** Only `priority: "critical"` notifications, and only for people who opted in, after the item
   sat unseen for N minutes (say 10) in work hours. The person who owns the item first, then the escalation ladder
   (owner, then lead) as today. Execs only for the company-wide "client on fire" items they already get.
2. **The call.** A new `phone_calls` table (person, notification, status, Twilio call SID, digits pressed, started and
   ended). A cron step (or the notifier itself) places the call through Twilio's REST API, with a status callback.
3. **The answer.** Option A's `<Gather>` posts back to `/api/phone/notice` (Twilio's request signature checked). "1"
   reads the item's detail; "2" snoozes it an hour. Either way the notification is marked seen and the assistant's
   next hello mentions it.
4. **Option B later.** The same table. The call goes through ElevenLabs' outbound-call endpoint with the person's id
   in `conversation_initiation_client_data`. The custom LLM endpoint looks the person up, loads their tools with their
   own access (never more than in the app), and saves each turn to `ai_role_chats` under a call row with
   `mode: "phone"`, so the transcript, notes, tasks and safety review work as for any call.
5. **Settings.** "Calls & usage" (owner) lists phone calls with the rest, and their cost.

## Sources

- [Twilio Voice pricing (US)](https://www.twilio.com/voice/pricing/us), [phone number pricing](https://www.twilio.com/en-us/phone-numbers/pricing)
- [ElevenLabs Agents: Twilio outbound call API](https://elevenlabs.io/docs/api-reference/twilio/outbound-call), [Twilio integration](https://elevenlabs.io/agents/integrations/twilio), [register call (own Twilio)](https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/register-call)
- [Google Voice FAQ for administrators](https://support.google.com/a/answer/9053675) (admin management only, no calling API)
