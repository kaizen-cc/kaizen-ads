# Phone-call notifications for urgent items

## Phase 1: built (Nov 24 2026), dormant until Twilio is connected

**What it does.** A critical item that sits unseen for 10 minutes rings the phone of the teammate it's for, if they
opted in. It's a short spoken notice: press 1 to hear the item (it's then marked seen), then press 1 again to get its
link by text; press 2 to snooze it an hour.
- **Who and when:** staff only, explicit opt-in with a consent box, critical items only, and never in their quiet
  hours.
- **Limits:** at most 3 calls an hour per person, and 2 per item (the second only after a snooze).
- **Where it's logged:** every call is a row in `phone_calls`, shown in Settings › Calls & usage and on the person's
  own Phone alerts tab.

**Code**
- Settings › Phone alerts: `src/app/(team)/settings/phone-alerts.tsx` and `phone-actions.ts`.
- The sweep runs every 5 minutes (`/api/cron/context?step=phone`): `src/lib/phone.ts`.
- The rules and the words spoken: `src/lib/phone-core.ts`.
- Twilio's callbacks, signature checked: `src/app/api/phone/[step]/route.ts` and `src/lib/phone-signature.ts`.
- The assistant's `phone_alerts` tool: `src/lib/assistant/phone-tools.ts`.

### Owner setup (about 20 minutes, plus a few days' wait for texting approval)

1. **Account.** Sign up at twilio.com with Kaizen's business details, then upgrade it (add billing). A trial account
   can only call numbers you've verified, and it adds a trial message to every call.
2. **A number.** Phone Numbers › Buy a number. A US local number with **Voice** and **SMS** ticked costs about
   $1.15 a month. Nothing needs setting on the number itself: Kaizen OS gives Twilio its webhook addresses on each call.
   Optional: set "A call comes in" to a TwiML Bin that says "This number only makes calls for Kaizen OS."
3. **Calls (no registration required, but do this so calls aren't shown as spam):** Trust Hub.
   - Create the business's Customer Profile.
   - Register for **SHAKEN/STIR Trusted Calling** and **Voice Integrity**.
   - Add **Branded Calls / CNAM** with the caller name "Kaizen OS" (or "Kaizen Marketing").
4. **Texting the link (only for "press 1 for the link by text"):** US texting from a local number needs **A2P 10DLC**
   registration. Calls work without it; texts may be blocked until it's approved.
   - Go to Messaging › Regulatory compliance and register the Brand (Standard; it needs the company's EIN).
   - Then register a Campaign: use case "Account notifications".
     - Sample message: "Kaizen OS: OceanBox spend doubled today https://…".
     - Opt-in: "Employees opt in themselves in Kaizen OS Settings › Phone alerts with a consent checkbox."
   - Twilio shows the current fees as you go. Approval takes a few days to a few weeks.
   - A toll-free number with Toll-Free Verification is the alternative.
5. **Countries.** Voice › Settings › Geo permissions. The US is on by default; switch on any country a teammate's phone
   is in (for example the Philippines, India, Greece, Spain). Do the same under Messaging › Geo permissions for texts.
6. **The three values.** From the Twilio Console home (Account Info), take the **Account SID** and the **Auth Token**,
   and the number you bought in +E.164 form (+15125550100).
7. **Vercel.** Project kaizen-ads › Settings › Environment Variables, for Production. Add:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN` (mark it Sensitive; never paste it into a chat)
   - `TWILIO_FROM_NUMBER`

   Twilio signs every callback for the exact address it calls, so the app's public address must be
   `NEXT_PUBLIC_SITE_URL`. Only if Twilio should call a different address, also set `PHONE_WEBHOOK_BASE` to it. Then
   redeploy.
8. **Test.** In Kaizen OS, open Settings › Phone alerts. Add your number, tick the consent box, turn it on, and press
   **Test call**. The call shows in Settings › Calls & usage.

Rotating the Auth Token in Twilio means updating `TWILIO_AUTH_TOKEN` in Vercel the same day; until then every callback
is refused (calls say nothing useful), which is the safe failure.

---

# Research (Nov 24 2026)

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
