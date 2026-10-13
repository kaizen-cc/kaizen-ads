# Kaizen Ads: Plan

Creative request → production → approval → launch, in one app, for Kaizen's creative team, paid team and clients.
Hosted at **ads.kaizenmarketing.agency**. Built as a standalone annex to Kaizen OS, the same way Kaizen Track is, and designed to be embedded in the OS later.

Status: **Phase 1 (foundation) in progress**. Last updated 2026-10-13.
Source of truth for intent: [docs/VISION.md](docs/VISION.md). If this plan and the vision disagree, the vision wins until Santi says otherwise.

---

## 1. Goals

1. **One place for the whole creative lifecycle.** This replaces the Google Form, the Asana Creative board, the per-client Creative Database sheets, the copy sheets and the "send to client" form.
2. **Clients approve in seconds.** A magic link opens a branded portal and a swipe deck: right = approve, left = request changes, with pinned image comments and timestamped video comments.
3. **Nothing gets lost.**
   - Every item has one owner, a stage, a due date and a business-hours clock.
   - Leaders see everything.
   - Client changes are routed automatically to the right person.
4. **Approved → launched with fewer errors.** Approval feeds the launcher. The AI proposes the setup, the media buyer confirms, and the ad is created **paused** in Meta through a system user, visible to every buyer. The buyer QAs it and turns it on.
5. **AI everywhere, editable by leadership.**
   - Every agent's instructions live in the app, with version history.
   - Only executives and leads can edit them.
6. **Clients see:**
   - what's waiting on them
   - what's in revision on our side
   - what's running (previews)
   - later, their allotment and their own requests

Out of scope for v1: Google, TikTok and Organic Social (v1 is **Meta only**), and performance metrics in the client portal.

---

## 2. Stack & environments

Same stack and conventions as Kaizen Track.

| Layer | Choice |
|---|---|
| Repo | GitHub `kaizen-cc/kaizen-ads` (private) |
| App | Next.js 16 (App Router, `proxy.ts`) + React 19 + TypeScript + Tailwind 4 |
| DB / Auth / Storage | **New dedicated Supabase project** (not Track's, not the OS's). RLS on every table. Storage for assets, with resumable (TUS) uploads. |
| Team auth | Google OAuth restricted to `@kaizenmarketing.agency`, invite-only |
| Client auth | Magic link to email. Branded emails are sent by us through Resend, with deep links (`admin.generateLink`). |
| Email | Resend, sent from `Kaizen Ads <ads@contact.kaizenmarketing.agency>` (mirrors Track) |
| Slack | Slack app posting to **each client's own channel** |
| AI | Claude API (latest Sonnet/Opus per agent). Motion is reached through the API's MCP connector. |
| Meta | Marketing API via a **Business Manager system user**. Every object is created `PAUSED`. |
| Hosting | Vercel (preview per PR, prod on `main`), CNAME `ads` → Vercel |
| Cron | Vercel cron: reminders and SLA checks every 15 min, running-ads sync hourly, email batching every 5 min |
| CI | Same as Track: eslint, typecheck, vitest, DB rule tests |

Timezone: **America/New_York**. The **business clock** counts **Mon–Fri, 08:00–18:00 ET** only. US holidays are in a configurable table and are also skipped.

---

## 3. People & permissions

### 3.1 Team roles

| Role | Who (today) | Does |
|---|---|---|
| **Executive** | Santi, Ryan (CMO), Kyle | Everything. Edits AI instructions, approves allotment upgrades, backs up internal creative review. |
| **Lead** | Jesus Araujo (Head of Creative) | Internal creative review. Edits AI instructions, approves allotment upgrades, sees all clients. |
| **Creative** | Graphic designers, video editors | Build and upload creative. Fix internal and client creative revisions. |
| **Media buyer** | Buyers per Account Overview | Request creative, write or approve copy, confirm launches, QA paused ads. |
| **Copywriter** | Camille | Reviews **all** copy, including AI drafts. |
| **Coordinator** | Jorgi | Sends to clients, chases approvals, routes client revisions, handles the 48h queue. |

- One person can hold several roles; flags are additive.
- Per-client assignments (Meta buyer, graphic designer, video editor, plus copywriter and coordinator defaults) are imported from the **Account Overview** sheet and editable in Admin.
- Execs and leads see every client. Everyone else sees the clients they're assigned to, plus anything assigned to them directly.

### 3.2 Client contacts
- A contact is one email. It links to **one or more clients**.
- Contacts see only their linked clients: approvals, in revision, running, and later requests and allotment.
- Any contact's approval counts (**first approval wins**).

| Capability | Creative | Buyer | Copywriter | Coordinator | Lead | Exec | Client |
|---|---|---|---|---|---|---|---|
| Create request | ✓ | ✓ | – | ✓ | ✓ | ✓ | later (counts vs allotment) |
| Upload creative / new version | ✓ | – | – | – | ✓ | ✓ | upload raw assets to a request |
| Internal creative review | – | – | – | – | ✓ | ✓ | – |
| Write copy | – | ✓ | ✓ | – | ✓ | ✓ | – |
| Copy review | – | – | ✓ | – | – | ✓ | – |
| Send to client / chase / route revisions | – | – | – | ✓ | ✓ | ✓ | – |
| Approve / request changes | – | – | – | push-to-approval* | – | – | ✓ |
| Confirm launch / mark live | – | ✓ | – | – | – | ✓ | – |
| Edit AI instructions | – | – | – | – | ✓ | ✓ | – |
| Approve allotment upgrade | – | – | – | – | ✓ | ✓ | request only |
| Admin (people, clients, assignments) | – | – | – | – | – | ✓ | – |

\* Jorgi can record an approval on a client's behalf, for example when a client approves over email or Slack, or when a client who opted into auto-approval passes 48h. It always requires a reason and is labeled **"Approved by Kaizen on client's behalf"** in the history. **Nothing is ever approved automatically** unless the client opted in (§5.6).

---

## 4. Workflow

### 4.1 Stages
These mirror the Asana board one-for-one, so the team keeps its mental model.

| # | Stage | Owner | Default due (business time) | Exit |
|---|---|---|---|---|
| 1 | **Requested** (Creative Brief) | Auto-assigned creative | Image **2 days**, video **4 days** from request (whole production) | Creative starts → 2 |
| 2 | **In production** (In Progress) | Designer (image/carousel) or editor (video) | (same clock as 1) | Uploads → 3 |
| 3 | **Internal review** (Creative for Review) | Jesus (backups: execs) | **Next business day** | Approve → 4 · Send back → 2 (with comments) |
| 4 | **Copy** (Ready for Copy) | Copy-writer agent drafts **immediately** (it uses client memory, §11b) | Immediate | Draft → 5 · Skip if the angle already has approved copy → 6 |
| 5 | **Copy review** (Copy for Review) | Camille **edits in place and passes it on**. There's no send-back loop. Her edits train the agent (§11b). | **Same day** | Done → 6 |
| 6 | **Ready for client** | Jorgi | **Next business day** | "Send to client" → 7 |
| 7 | **Client review** (Sent to Client) | Client (Jorgi tracks) | Reminders **24h** and **48h** → Jorgi queue (Jorgi's due date is **2 days**) | Approve → 9 · Changes → 8 |
| 8 | **Client revision** | Auto-routed: creative changes → creative; copy changes → buyer (then Camille) | **24 business hours** | Fixed → back to 6 for Jorgi to re-send |
| 9 | **Ready for launch** | Media buyer | **24 business hours** | Launcher proposal confirmed → pushed paused → 10 |
| 10 | **Launched** | Media buyer | – | Buyer turns it on in Meta. It shows under "Running" for the client. |

- **Priority** is a real field: Normal / High / Urgent. Urgent shortens due dates (configurable). No more "URGENT: URGENT:" in titles.
- **Tags**: Founder, UGC, AI-flagged, BFCM, and so on. Filterable.
- **Stage events** are timestamped, so turnaround is measured end to end, not only request → internal review as the KPI board does today.
- **Overdue** items turn red on the board and notify the owner. At 2× SLA they also notify the owner's lead.

### 4.2 Creative and copy move separately
- A request produces **designs**. Each design has versions, and each version has sized files.
- **Copy belongs to the angle**, not the request (§8).
- When a design passes internal review:
  - If the angle **already has approved copy**, the design skips 4–5 and goes straight to Ready for client. The client only approves the creative.
  - Otherwise the angle's copy set moves through 4–5 in parallel.
- A design reaches **Ready for launch** when both its creative is client-approved **and** its angle's copy is client-approved.

### 4.3 Client revisions
- When the client swipes left, they choose what needs changing: **the creative**, **the ad copy**, or both. Inside the creative, "text on the creative" is labeled separately from ad copy, which prevents the Blue Spring confusion.
- **Creative** changes go to the assigned designer or editor, who uploads a new version (v2). **Ad copy** changes go to the buyer, then Camille.
- When fixed, the item returns to Jorgi's **Ready for client** with "v2 ready to re-send". The client sees v2 with their own comments beside it and a "what changed" note.
- Uploaders, buyers, Jesus and Jorgi are **all** notified of client comments, not just the uploader.

---

## 5. Client portal

### 5.1 Getting in
- **From a notification**, the magic link deep-links to that client and that item (`/c/{client}/review?item=…`).
- **Direct visit**:
  1. The client enters their email.
  2. If it matches a contact, we email a link. The response is always "check your inbox", so we never reveal which emails exist.
  3. A contact with several brands lands on a **brand picker**.
- **Brand switcher**: the client name in the header is a dropdown of every brand the contact can access.
- Sessions last 30 days on that device. Links expire after 24h and are single-use.

### 5.2 Home (per brand)
Four sections, with the most urgent first:
1. **Waiting on you**: a count plus a **Start reviewing** button that opens the swipe deck. It's grouped by batch.
2. **In revision**: items where the client asked for changes and v2 isn't uploaded yet, with their comment and "Kaizen is on it".
3. **Running now**: previews of the client's live Meta ads, synced hourly, with no metrics.
4. **Approved / launching**: approved and in the launch queue.

Later: **Requests and allotment** ("6 of 10 images used this month", open requests, "New request", "Upgrade package").

### 5.3 Swipe deck
- **One card = one ad as it will appear**: a Feed or Story mockup with the brand's name and avatar, the creative, and the angle's primary text, headline and CTA.
  - A toggle switches between placements (1:1 / 4:5 / 9:16) when several sizes exist.
  - Copy variations (up to 3 headlines and 3 primary texts) can be swiped *within* the card. Approving copy approves the set.
- **Right / ✓**: approve. If both creative and copy need approval, the client approves each (two small toggles, both on by default).
- **Left / ✎**: request changes. A sheet opens with:
  - What needs changing: Creative / Ad copy
  - **Pin on the image** (tap to drop a numbered pin), or **comment at a timestamp** (pause the video, tap comment)
  - Free text
- **Up / skip**: decide later.
- Works with touch, mouse and keyboard (← → ↑). Undo the last swipe for 10 seconds.

### 5.4 Batch view
- Designs from the same request **and** angle form a **batch**, e.g. "BFCM – Buy More Save More · 5 designs".
- A grid shows the whole batch.
- **Approve all** is available, but **"approve all" plus one exception** is the common path: approve the batch, then flip one card.
- Variations (same design, different text or CTA) stack under their parent design.

### 5.5 Notifications to clients
- **Email** (branded, one magic link):
  - Sends are batched: "5 new ads ready for your review". This happens when Jorgi presses Send, or as a daily digest.
  - A **24h reminder**.
  - A **48h final reminder**: "Approval needed so we don't miss your marketing moment".
- **Slack**: also posted to the client's own Slack channel when they share one with us.

### 5.6 Optional auto-approval (client opt-in)
- There's a checkbox in client settings: **"If I don't respond within 48 business hours, approve automatically."** It's off by default.
- When it's on, items pass 48h, get a final email and auto-approve, labeled as auto-approved.
- When it's off, items go to **Jorgi's queue**. She nudges the client, or records an approval the client gave elsewhere.

---

## 6. Team app

- **Pipeline board**: the Asana replacement.
  - Columns = stages.
  - Filters: client, assignee, format, priority, tag, overdue.
  - Cards show the client, title, format icon, priority, due date and SLA badge.
  - There's also a list view.
- **My work**: everything assigned to me, sorted by due date.
- **New request**: the brief builder.
  - Fields: client, platform (Meta), format (image / video / carousel, multi), new vs iteration, angle (pick from the client's library or create), audience, offer, description, references (Motion links, ads to iterate), sizes needed, due date, priority, "client sent assets?" plus an upload.
  - The **AI brief builder** can expand a rough note into the structured brief. Today's freeform multi-brief docs become structured briefs.
- **Request page**: the brief, the client's quick links (website, Motion, etc.), stage history, checklists, and **built-in agents** that replace the Google Doc prompts in every Asana task (video script, image concept, copy).
- **Upload**: drag in files. The app reads the size suffix (`_1x1`, `_4x5`, `_9x16`) or detects the aspect ratio, groups sizes into one design, and asks "New design or variation of…?".
- **Internal review** (Jesus): the same viewer as clients, with pins and timestamps, and Approve or Send back.
- **Copy editor**: per angle, short and long form, 3 headlines (40 chars) and 3 primary texts (125 chars) with live counters, a landing URL and a CTA. There's a "Draft with AI" button; its output goes straight to Camille.
- **Jorgi's queue**:
  - Ready to send (grouped by client, one press sends a batch)
  - Waiting on client, with a business-hours timer
  - Past 48h, with buttons for Nudge, Record approval and Auto-approve (only if opted in)
  - Client revisions to route (auto-routed, but she can override)
- **Launch queue** (buyers): approved designs + copy → the launcher's proposal → Confirm → pushed paused → "QA in Ads Manager" link → Mark live.
- **Admin** (execs): people and roles, clients, contacts, assignments, Slack channel IDs, ad account IDs, holidays, SLA settings, deliverable-counting rules, **AI instructions**.

---

## 7. Assets, designs, batches

- **Storage**: Supabase Storage, private bucket, signed URLs, resumable uploads (videos of 5–60s, 1 to 20+ a month per client).
  - Thumbnails, poster frames and a web-friendly preview are generated on upload.
  - Originals are kept for the push to Meta.
- **Uploading must be effortless.**
  - Drag a folder or files onto a request (or onto the client, and the app asks which request).
  - Sizes are auto-detected. Uploads are resumable and run in the background with progress, so the creative can keep working.
  - Upload from a phone works too.
  - No Drive links to copy.
- **Replace file = new version.** On any design, **Replace** uploads a new version (v2, v3…).
  - Nothing is ever deleted.
  - The client and the team see the **newest version by default**, with a **version history** strip (v1 · v2 · v3) to compare side by side, each with its comments and a "what changed" note.
  - Replacing during client review restarts that item's client clock and notifies Jorgi.
- **Hierarchy**: Request → **Design** (one creative idea) → **Version** (v1, v2… after revisions) → **Files** (1 per size).
- **Variation**: a design flagged "variation of X". It uses the same graphics and tests text, CTA or button placement, and **doesn't count** toward the allotment.
- **Carousel**: one design with ordered cards. It counts as **1**.
- **Batch**: designs that share a request and an angle. Detected automatically, no tagging needed.
- **Drive**: the app doesn't depend on Drive. An optional "mirror to Drive" (Month / Angle / file, per the 10/08 convention) can be added if the team still wants Drive folders.

---

## 8. Copy model

- Every client has an **angle library**: angles and avatars like "Fresh, never frozen" or "Focus for moms", seeded by the go-to-market agent or created during requests.
- A **copy set** belongs to an angle:
  - up to **3 primary texts** (short ≤125 and long form)
  - up to **3 headlines** (≤40)
  - a description, a CTA and a landing URL
  - its own versions
- **Approved once per angle**, it covers every design on that angle. New designs on an approved angle don't ask the client to approve copy again; the card shows "Copy previously approved" with a link to see it.
- The launcher pairs each approved design with its angle's approved copy set, so the "best performing copy" question goes away.

---

## 9. Allotment & upgrades

- **Monthly allotment per client**: images and videos, seeded from the Creative KPI board (*Images Expected / Videos Expected*).
- **Counting** (configurable; Kaizen is still finalizing the rules):
  - new design = 1
  - variation = 0
  - carousel = 1
  - sizes of one design = 1
  - revisions = 0
- Counting happens when a design passes **internal review**. The setting is configurable.
- **Client view** (later phase): used vs remaining, open requests, **New request** (counts against the allotment), **Upgrade package**.
- **Upgrade flow**:
  1. The client requests an upgrade.
  2. **Santi gets an email** so he can invoice.
  3. In-app and email notice to **Ryan and Jesus**.
  4. The upgrade stays **pending** until an **exec or lead approves** it.
  5. Once approved, the new allotment is active and the agents can start generating requests.

---

## 10. Notifications

In-app (bell + realtime), email (batched every 5 minutes, respecting each person's preferences) and Slack.

| Event | Who is notified |
|---|---|
| New request | Assigned creative (in-app + email); buyer if someone else filed it |
| Overdue at any stage | Owner; at 2× SLA also their lead |
| Uploaded for internal review | Jesus |
| Internal send-back | Creative |
| Ready for copy | Buyer |
| AI copy draft / copy submitted | Camille |
| Copy sent back | Buyer |
| Ready for client | Jorgi |
| **Sent to client** | Client contacts (email + magic link) · client Slack channel |
| 24h / 48h without response | Client (reminder / final) · at 48h, Jorgi's queue |
| **Client approved** | Client Slack channel · buyer · Jorgi · uploader |
| **Client requested changes** | Routed owner · uploader · buyer · Jesus · Jorgi |
| v2 uploaded after a client revision | Jorgi (re-send) |
| Launcher proposal ready | Buyer |
| Pushed paused to Meta | Buyer ("QA now" link) · client Slack channel (optional) |
| Upgrade requested | Santi (email) · Ryan + Jesus |
| Upgrade approved | Client · Santi · buyer · creative assignees |
| AI agent failed / Meta push failed | Owner + Santi (ops) |

---

## 11. AI agents & instruction registry

Every agent has a **key, a model, instructions (a versioned prompt), input schema, output schema and tools**.

- **Execs and leads** can edit the instructions in Admin → AI.
- Each save is a new version with an author and a note. One-click **rollback**.
- A **"test run"** button runs the draft against a sample request before it's published.
- Every run is logged with inputs, output, model, tokens, cost and who triggered it.

| Agent | Trigger | Output | Goes to |
|---|---|---|---|
| **Go-to-market onboarding** | Marketing intake form for a **new client** | Angle and avatar library + first-round requests | Exec/lead approves → requests created |
| **Brief builder** | "New request" (button) or another agent | Structured brief from a rough note + context (Motion top ads, existing angles, ad account) | Requester edits → submits |
| **Video script** | On a video request | Hooks, script, shot list (replaces the "AI Prompt for Video Script" doc) | Creative |
| **Image concept** | On an image or carousel request | Concepts, on-image text, layout notes (replaces the single-image prompt doc) | Creative |
| **Copy writer** | Ready for copy (button or auto) | Copy set for the angle (3 primary + 3 headlines, short + long) using the brief, **the actual creative**, audience, angle and top copy from Motion | **Camille** (straight to copy review) |
| **Launcher** (Kyle's slot) | Ready for launch | Campaign / ad set / ad name / CTA / URL / placements proposal | Buyer confirms → Meta |
| **Fatigue watcher** (later) | Daily | Fatigue alerts + iteration requests ("AI-flagged") | Buyer + creative queue |

### 11b. Learning loop & client memory

The goal is to **never repeat the same mistake for a client**.

- **Copy learning (Camille's edits)**:
  - Every copy set stores the **AI draft** and **Camille's final** side by side. The difference is saved as an edit record (`copy_edits`).
  - After each edit, a small **"lesson" agent** reads the before and after and writes short, specific lessons. Examples: "Crust Pizza: say 'pies', not 'pizzas'"; "Never use exclamation marks for Remedy Place".
  - Lessons go into that **client's memory**. The client's most recent before/after pairs are also given to the copy-writer agent as examples, so it imitates Camille's edits for that client.
- **Feedback memory**: three kinds of feedback are captured and summarized into the **client's memory**, each linked back to its source:
  - every **internal send-back** (Jesus)
  - every **client change request** (pins, timestamps, notes)
  - every Camille edit

  Examples: "Logos must be large and at the top"; "When promoting one item, show one pizza, not three"; "'Copy' from this client means on-image text".
- **Used everywhere**: the brief builder, the video-script and image-concept agents, and the copy writer all receive the client's active memory with every run.
- **Pre-send check**: before Jorgi presses "Send to client", the app checks the batch against the client's memory and flags anything that repeats past feedback.
- **People stay in control**:
  - Client memory is visible on the client page under "What we've learned". Leads and execs can edit, pin or archive any lesson.
  - Lessons that look **global** (true for every client) are only **proposed** as changes to an agent's main instructions. An exec or lead approves each one, and it becomes a new version with rollback (§11). Global instructions never change silently.

**Kyle's launcher slot.** Kyle's media-buyer logic drops into `agents/launcher/` (instructions + rules as Markdown, plus an optional JSON schema for the proposal).
- The app supplies a fixed input: client, ad account, approved design files and sizes, angle, copy set, landing URL, request brief, existing campaigns and ad sets (read from Meta).
- It expects a fixed output: the proposal.
- The buyer always confirms. Nothing goes live without a person turning it on.

---

## 12. Meta integration

- **Reuse the Meta app**: Kaizen OS already has a Meta app (`META_APP_ID` / `META_APP_SECRET` in the `kaizen-cc` Vercel project). The OS uses it for per-user OAuth logins and holds **no system-user token**. Kaizen Ads reuses the **same app**: copy its ID and secret into the Ads Vercel project, and generate a **separate system-user token** for Ads so each app can be revoked independently.
- Client **ad accounts, Pages, Instagram accounts and datasets (pixels)** are all shared to Kaizen's BM (confirmed). Assign them to the system user.
- **Auth**: Kaizen's **existing system user**. What's needed:
  - A **Meta app** owned by Kaizen's Business Manager (create one if the system user's token isn't already tied to one), added to the system user under *System users → Add assets / Apps*.
  - **Assets assigned to the system user**, for every client:
    - the **ad account** (permission: *Manage campaigns*)
    - the client's **Facebook Page** (*Create ads* / advertise)
    - the **Instagram account** used for ads
  - A **token** generated for that app with `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement` and `instagram_basic` (plus `pages_manage_ads` if Meta asks for it). Set it to never expire.
  - The token goes **straight into Vercel env vars** (`META_SYSTEM_USER_TOKEN`), plus `META_APP_ID` / `META_APP_SECRET` and `META_BUSINESS_ID`. It is never pasted into chat, email or Slack.
  - Step 0 confirms that the app's access level is enough to create ads in client-owned accounts shared to Kaizen's BM.
- **Push**:
  1. Upload the image or video to the ad account.
  2. Create the ad creative (copy set + CTA + URL, with placement-specific assets).
  3. Create the ad in the chosen ad set. Create a new campaign or ad set only if the proposal says so.
  4. Every object is created **`PAUSED`**. Ads created through the API are real paused objects, not per-user drafts, so **every buyer on the account can see them**.
- **Naming**: the app generates names from a configurable template that encodes client, angle, format, size and date, so reporting and Motion stay consistent.
- **Running now**: an hourly sync of active ads per client (preview thumbnails and preview links) for the client portal.
- **Step 0, before building**: validate on one ad account that
  - (a) the system user can create paused ads in a client-owned account shared to Kaizen's BM
  - (b) another buyer sees them in Ads Manager
  - (c) how Meta treats a creative with no primary text (copy should always exist, so this is a safeguard)
- **Ad account IDs**: from the Account Overview media-buying tab.

---

## 13. Data model (Supabase / Postgres)

All tables have RLS. Helper functions live in a `private` schema (Track pattern). Writes go through `security definer` RPCs with `assert_*` checks.

```
profiles            id, email, name, is_exec, is_lead, is_creative, is_buyer, is_copywriter, is_coordinator, active
clients             id, kaizen_id (Account Overview ID), name, status, slack_channel_id, meta_ad_account_id,
                    fb_page_id, ig_account_id, brand_avatar_url, auto_approve_opt_in, timezone
client_assignments  client_id, profile_id, role (meta_buyer|graphic_designer|video_editor|copywriter|coordinator)
contacts            id, email (unique), name
contact_clients     contact_id, client_id, is_primary
angles              id, client_id, name, kind (angle|avatar), description, source (manual|gtm_agent|request), active
requests            id, client_id, platform, formats[], request_type (new|iteration), angle_id, audience, offer,
                    brief jsonb, references jsonb, priority, tags[], requested_by, source (team|client|agent),
                    stage, assignee_id, due_at, stage_entered_at, created_at
designs             id, request_id, angle_id, title, kind (design|variation|carousel), variation_of,
                    counts_toward_allotment, creative_status, current_version
design_versions     id, design_id, version, uploaded_by, change_note, created_at
assets              id, version_id, storage_path, mime, width, height, aspect (1x1|4x5|9x16|other),
                    duration_s, card_index, thumb_path, preview_path, meta_hash/video_id
copy_sets           id, angle_id, version, status, primary_short[3], primary_long[3], headlines[3],
                    description, cta, landing_url, written_by (profile|agent), created_at
decisions           id, subject_type (design_version|copy_set), subject_id, stage (internal|copy|client),
                    decision (approve|changes), actor_profile_id | actor_contact_id, on_behalf_reason,
                    auto (bool), created_at
comments            id, subject_type, subject_id, author (profile|contact), body, target (creative|ad_copy),
                    anchor jsonb ({x,y} | {t} | {card}), resolved_by, created_at
stage_events        id, request_id, design_id, from_stage, to_stage, actor, at
client_reviews      id, client_id, sent_by, sent_at, items[], first_viewed_at, reminder_24_at, reminder_48_at,
                    escalated_at
launches            id, client_id, design_ids[], copy_set_id, proposal jsonb, agent_run_id, confirmed_by,
                    meta_campaign_id, meta_adset_id, meta_ad_ids[], status, error, created_at
running_ads         client_id, meta_ad_id, name, preview_url, thumb_url, effective_status, synced_at
allotments          client_id, period (month), images, videos
allotment_changes   id, client_id, requested_by_contact, images, videos, status (pending|approved|rejected),
                    approved_by, invoiced (bool), created_at
copy_edits          id, copy_set_id, client_id, ai_draft jsonb, final jsonb, editor_id, created_at
client_memory       id, client_id, lesson, kind (copy|creative|brand|process), source_type
                    (copy_edit|internal_review|client_feedback|manual), source_id, status (active|archived),
                    pinned, created_by (agent|profile), updated_at
instruction_proposals id, agent_key, proposed_change, evidence jsonb, status (pending|approved|rejected), decided_by
agents              key, name, description, model, input_schema, output_schema, tools jsonb
agent_versions      id, agent_key, version, instructions, notes, created_by, published_at, active
agent_runs          id, agent_key, version, input jsonb, output jsonb, tokens, cost_usd, triggered_by, status, created_at
notifications       (Track pattern) + email_prefs + slack_outbox
holidays            date, name
settings            sla per stage & format, priority multipliers, counting rules, naming template
```

Key functions:
- `business_minutes_between(a, b)` and `add_business_minutes(t, m)`, using the 08:00–18:00 ET Mon–Fri window minus holidays
- `advance_stage(...)`
- `record_decision(...)`
- `route_client_revision(...)`
- `count_allotment(client, month)`

---

## 14. Integrations & data import

| Source | What | How |
|---|---|---|
| **Account Overview** sheet | Clients, IDs, status, POC + other emails (→ contacts), Meta buyer, designer, editor, copywriter, ad account ID, creative folder | One-time import + "re-sync" button. The app is the master after go-live. |
| **Creative KPI board** | Images and videos expected per month (→ allotments) | One-time import |
| **Kaizen Track** | Client list (same IDs) | Nightly sync, or a shared Zapier enrollment hook |
| **Slack** | Per-client channel IDs | Admin field + Slack app |
| **Motion** | Top creatives and copy, angles, fatigue signals | Agents call Motion via MCP connector (or API) |
| **Meta** | Push paused ads; sync running ads | System user |
| **Asana** | ~140 open tasks on the Creative board | Cut-over plan (open question 3) |
| **Creative Database sheets** | History of past approvals | Read-only link per client; not migrated |

---

## 14b. Kaizen Track time tracking (later phase)

Goal: creatives track time **inside Kaizen Ads**, and it lands in Kaizen Track automatically, with no double counting.

- **Timer in the app**: a Start/Stop timer on every request and design (and on revision tasks).
  - The app already knows the **client**, the **creative type** (image / video / carousel / revision) and the stage, so the person doesn't pick anything.
  - Starting a timer in Ads stops any running timer in Track (Track allows one running timer per person).
- **Mapping to Track**: client → Track client → the client's creative project. Creative type and stage → Track category (e.g. Graphic Design, Video Editing, Revisions). The mapping table is editable in Admin.
- **Write path**:
  - Ads calls a new Track endpoint (`/api/integrations/kaizen-ads`, shared secret, idempotency key).
  - The endpoint creates or updates a Track `time_entries` row with a new `source = 'kaizen_ads'`, an `external_id` (the Ads timer session) and a description such as "Crust Pizza Co. · $8 Calzone Mondays · Design v2".
  - Live timers show as running in Track as well.
- **No duplicates**: Track already has a database rule that a person **cannot have two entries that overlap in time** (`time_entries_no_overlap`). Building on it:
  - If someone adds a **manual** Track entry that overlaps time already logged from Ads, Track blocks it with a clear message: "You already tracked 2:10–3:05 pm on Crust Pizza Co. from Kaizen Ads." It offers to **edit that entry** instead.
  - If a manual entry in Track already exists and the Ads timer would overlap it, the Ads entry is trimmed to the free time, or the person is asked which one to keep.
  - The same Ads session is never written twice; idempotency comes from `external_id`.
- Entries from Ads are `approved` (timer-based, like Track's own timer). Manual adjustments still follow Track's approval rules.
- **Bonus**: real time per deliverable lets the app compare effort with the allotment and show turnaround versus hours per client.

---

## 15. Branding

Identical to Kaizen Track:
- **Colors**: dark-first with `#B21E2C` brand red, plus the same surface and text tokens (`src/app/globals.css` in Track).
- **Type**: Poppins body, GT Flexa headings (licensed file needed), Osake display (re-subset for "ads").
- **Shape**: 5px radius. Sidebar shell on desktop, bottom-sheet patterns on phone.
- **White-label clients** see **Kaizen branding** for now. A white-label portal is a future idea.
- **Client portal**: the same system, warmer and simpler. It's mobile-first, because clients will approve from their phones, and it uses the client's logo and name inside the ad mockups.

---

## 16. Phases

| # | Phase | Done when |
|---|---|---|
| 0 | **Mockups** | Clickable branded mockups approved: client swipe deck + home, team pipeline board, Jorgi's queue |
| 1 | **Foundation** | Repo, Supabase, Vercel, `ads.` domain, team Google SSO, client magic link, roles, Account Overview + KPI import, angle library |
| 2 | **Pipeline** | Requests + brief form, board + My work, uploads (resumable, size detection, designs/versions/variations), internal review with pins and timestamps, copy editor + Camille review, SLAs and the business clock |
| 3 | **Client portal** | Home, swipe deck, batch view, comments, revision routing, Jorgi's queue, 24h/48h reminders, opt-in auto-approval, emails, Slack |
| 4 | **Launch** | Meta step 0 validated, Kyle's launcher slot wired, paused push, launch queue, running-ads sync |
| 5 | **Agents** | Instruction registry + editor + versions + runs; copy writer, brief builder, video script, image concept, GTM onboarding; Motion |
| 6 | **Allotment** | Counting, client allotment view, client requests, upgrade flow with exec/lead approval |
| 7 | **Cut-over** | Pilot with 2–3 clients for a week alongside Asana, then everyone; Asana Creative board and Creative Database sheets retired |
| 8 | **Track time** | In-app timer → Kaizen Track with no duplicates (§14b) |
| 9 | **Later** | Fatigue watcher, Google/TikTok/Organic approvals, social calendar, white-label portal, OS embed |

**Cut-over (decided)**: new requests go to the app from a set date; the open Asana tasks finish in Asana.

---

## 17. Open questions

1. ~~SLAs~~ **Decided**: AI copy is immediate, buyer copy revision same day, client revisions 24h, launch 24h.
2. **Meta**: the system user exists. Is a Meta app already attached to it? Are all client Pages and IG accounts (not just ad accounts) shared to Kaizen's BM? White-label clients may differ.
3. ~~Asana cut-over~~ **Decided** (see §16).
4. **Client rollout**: announce the portal to all clients at once, or pilot first? Do existing Creative Database sheets stay readable as history?
5. **Kyle's launcher**: what format are his instructions in now (Claude project, Markdown, skills)? Also, the naming conventions and campaign-structure rules per client.
6. **Fonts**: licensed GT Flexa webfont (same blocker as Track).
7. **Slack**: install a Kaizen Ads Slack app. Do all clients have a shared channel, or are some internal-only?
8. **Motion**: an API key or MCP access for the app (server-side), separate from personal logins.
9. ~~White-label branding~~ **Decided**: Kaizen branding for now.
10. **Deliverable counting**: confirm the final rules once Kaizen settles them internally (defaults in §9).
