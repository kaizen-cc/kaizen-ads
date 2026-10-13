# Kaizen Ads: Vision & Process Capture

> This is the source of truth for **what** we're building and **why**. Everything Santi has said about the process is captured here. Nothing in this file is to be dropped without his sign-off. PLAN.md (the build spec) is derived from this file.
>
> Domain: **ads.kaizenmarketing.agency** · Stack: Next.js + Supabase (its **own new project**) + Vercel + GitHub (kaizen-cc). Same look, feel and branding as Kaizen Track.

---

## 1. The vision (in Santi's words, lightly organized)

- One app/environment for the **paid team, the creative team and clients**. Our current process is "VERY clunky and not super modern." The goal is a genuinely incredible experience for customers *and* the team.
- **Creative team** logs in and uploads the assets they created. **Media buyers** add the copy. Each of these steps triggers **notifications to the client** that they have things to approve.
- **Clients** get a **magic link** to their portal, where they see creative itemized. The system intuitively detects **batches of variations** and shows them in a batch view.
- **Tinder-style approval**: swipe right to approve, swipe left to deny, for creative and for copy.
- **On approval**, Slack is notified (in the **client's own Slack channel**), the approval is written to the database, and the ad is pushed to Meta **paused** for the media buyer to QA and turn on.
- **Client portal shows**:
  - what's **currently running** (previews only, no metrics for now)
  - what is **pending from our team** (a revision they requested that hasn't been re-uploaded yet)
  - what is **waiting on them** to approve
- **Login**: the magic link in the notification takes them straight to the right brand and screen. Or they "log in" with their email and the system matches it to the right client or clients.
- **One contact can belong to several clients.** The magic link opens the right brand, with a brand-switcher dropdown (top-left title). A direct login with several brands shows a **"pick a brand"** screen first.
- **Move the whole creative request → production → approval process into this app** so nothing bounces between Asana and the app.
- **Editable AI instructions.** Every AI in the system (copy generation, request/brief builder, ad launcher, and others later) has instructions that **only executives and leaders** can view and edit, "so we can always go under the hood."
- Long term, this is a sub-product that gets embedded in the **Kaizen OS**.

## 2. Today's process (the backbone we're replacing)

1. **Request** → a Google Form ("F053.2 Creative Submission Form", ~1,122 responses). It is submitted by:
   - a **creative** doing a creative assessment
   - a **media buyer** who sees creative fatigue or an opportunity to A/B test a winning ad
   - a **media buyer** because the client is running a **sale or offer**
2. **Assignment**: the task goes to the client's **graphic designer** (images and carousels) or **video editor** (video), using the **Account Overview** sheet.
3. **Production**: the designer or editor builds it and submits it.
4. **Internal creative review**: **Jesus (Head of Creative)** either sends it back to the creator for revision or moves it to **copy**.
5. **Copy**: the **media buyer** writes the copy (Meta copy sheet template: 3 headlines ≤40 chars, 3 primary texts ≤125 chars short form, plus a long-form version of each, and a landing page URL).
6. **Copy review**: the **copywriter** approves it and moves it to **CS**, or kicks it back to the buyer for revision.
7. **Send to client**: CS fills out *another* form, which triggers the client notification that creative is ready for review. Clients currently review and comment in a per-client **Creative Database** Google Sheet, plus email and Slack.
8. **Client follow-up**: Jorgi manually moves the task to "sent to client" and keeps tabs on who to follow up with or who needs to be pushed.
9. **Client revisions**: Jorgi routes them, **creative revision → designer/editor**, **copy revision → media buyer**. The work comes back to Jorgi, who **re-sends it to the client**.
10. **Approved** → back to the **media buyer** to build the ad and make it live. *(New process: the app creates the ad paused for the buyer to QA and turn on.)*

### Known pain points
- Revision comments only notify the uploader, so leaders are blind. A Blue Spring revision sat lost for **30 days** because "copy" was ambiguous (on-image copy vs ad copy).
- Copy lives in a separate sheet per request, and iterations get missed.
- New copy is often the same approved copy pasted again, so the client re-approves the same thing.
- Three forms and two sheets for one creative. Google Sheets are hard for clients ("I don't even know where to start") and hard for AI to read.
- Media buyer launch errors. BFCM is coming.
- Meta drafts are visible only to the person who created them.

## 3. Decisions made (2026-10-13)

| Topic | Decision |
|---|---|
| Meta push | Business Manager **system user** creates ads **PAUSED**, visible to every buyer on the account. The buyer QAs and turns it on. Validate on one account first. |
| Assets | **Uploaded into the app** (Supabase Storage, resumable). Not Drive-first. |
| Copy model | Copy stored **per angle/avatar**. The client sees a **full ad preview**, and **creative and copy are approved separately**. Already-approved copy isn't re-asked. |
| Database | **New, separate Supabase project.** Clients and team synced in from Track and the Account Overview sheet. |
| Roles source | Account Overview sheet (Meta buyer, Google buyer, graphic designer, video editor, copywriter, etc. per client). |
| Approval rule | **First** approval from any client contact counts. |
| Reminders | **24h** reminder, then a **48h** final reminder. Counted in **business time only**: weekends don't count (e.g. something sent Friday 5pm ET starts counting **Monday 8am ET**). |
| Auto-approval | **Never automatic by default.** At 48h it moves to **Jorgi's queue**: she nudges the client or pushes it to approval. Auto-approval only applies if the **client opted in with a checkbox**. |
| Jorgi | Owns chasing approvals, routing revisions and re-sending. |
| "Currently running" | **Previews only**, no metrics (for now). |
| Slack | Post to **each client's own channel**. |
| Approved → launch | Goes to the in-app **Claude launcher**: the AI suggests campaign, ad set and naming, the **buyer confirms**, and it's pushed paused via the system user. No intermediate sheet. |
| Launcher logic | **Kyle Barry** owns the media-buyer thinking and instructions (currently on his machine). Build a **pluggable slot** he can drop into. It must be intuitive enough to launch correctly. |
| Timeline | No calendar pressure. Santi intends to build fast (this week). |
| Copy reviewer | **One copywriter** reviews all copy. |
| Client chasing | **Jorgi only**. |
| Internal creative approval | **Jesus** (Head of Creative), plus the execs **Ryan (CMO), Kyle, Santi** as backups. |
| Business hours | Approval clocks count **Mon–Fri, 8am–6pm ET** only. |
| What counts as a deliverable | A **new deliverable** is a distinct design (e.g. a folder of similar-style designs with different products = several deliverables). A **variation** reuses the same graphics/design and tests copy, title, CTA or button placement (A/B test), and does **not** count as a new deliverable. A **carousel = 1 deliverable**. Sizes of one design = 1. *Kaizen is still finalizing these rules internally, so keep them configurable.* |
| Copy structure | Copy is approved **once per angle** and covers all creatives on that angle. Each copy set has **up to 3 primary texts and 3 headlines**. |
| Platforms (v1) | **Meta only.** Expand to Google, TikTok and Organic once the shell is right. |
| AI agents (v1 list) | Copy writer · Brief builder · Launcher (Kyle's slot) · Fatigue watcher (later). Plus a possible **Go-to-market / onboarding agent** for new clients from the marketing intake form (see §4). |
| AI copy routing | AI-written copy goes **straight to the copywriter**. |
| Upgrade request | **Email Santi** (to process invoicing) and **notify Ryan + Jesus** that the upgrade happened. New allotment kicks in, and agents can start generating requests. |
| Copywriter | **Camille** reviews all copy. |
| Stage SLAs (today) | Production: **images 2 days, videos 4 days** from request. Internal review: **next day**. Copy review: **same day**. Ready for Client: **next day**. Sent to Client: **2 days out** (Jorgi's follow-up reminder). |
| Allotment upgrade activation | The new allotment only starts once an **exec or lead approves** the upgrade (a failsafe). |
| More SLAs | **Copy**: AI writes it immediately; the buyer/Camille revision happens the **same day** it's assigned. **Client revisions: 24h** turnaround. **Launch: 24h**. |
| Meta system user | Kaizen **already has a system user** in its Business Manager. |
| Asana cut-over | New requests go to the app from a set date; open tasks finish in Asana. |
| White-label clients | See **Kaizen branding** for now. A white-label portal experience is a future idea. |
| Creative uploads | It must be **very easy** for creatives to upload so assets are hosted and visible to clients. Creatives can **replace a file** with a new version; the client sees the newest version by default but can open the **version history**. |
| Copy review | **Camille edits and passes it on to the client stage.** No back-and-forth with the buyer (it would create a bottleneck). |
| AI learning loop | Camille's edits continuously teach the copy agent how to write for **that client**. |
| Client memory | All internal and client **feedback is stored per client**. It's used as context for future requests, briefs and copy so the **same mistakes aren't repeated**. |
| Meta assets | Ad accounts, Pages, Instagram accounts and **datasets (pixels)** are all shared to Kaizen's BM. Kaizen OS already has a Meta app (ID and secret) we can reuse. |
| Creative intelligence | Kaizen uses **Motion** (motionapp.com) for creative and account metrics, and it has an **MCP**. Use it for fact-finding: fatigue detection, top-performing angles and copy, and brief context. |

## 4. Future ideas (keep, don't build first)

- **Client allotment**: the portal shows the client's creative allotment (images and videos expected per month, already tracked on the Creative KPI board) and open requests. **Clients can submit their own requests**, which count against the allotment, with an **"upgrade package"** option. (Santi: "opens a can of worms.")
- **AI-written copy**: use the brief, the actual creative, the intended audience and the messaging angle, plus our editable instructions, to generate copy for the buyer and copywriter to review.
- **AI-generated requests**:
  - when a client submits the **marketing intake form**, auto-create first-round creative requests
  - pull **Meta metrics**: if an account shows **creative fatigue**, alert the media buyer and auto-open a creative ticket for iterations
- **New client vs existing client briefs**: the brief builder leans on existing ad account, Drive and Motion context. A brand-new client has none of that. So the **marketing intake form** should go to a **go-to-market onboarding agent** (or a GTM mode of the brief agent). It turns the intake into an angle/avatar foundation plus first-round creative requests.
- **Built-in time tracking that feeds Kaizen Track**: a timer in this app knows the client and the creative type. It logs the entry in Kaizen Track for the user automatically, so tracking is simpler. If someone also adds time manually in Track, the system must **not count duplicate entries**.
- **White-label portal**: a neutral or agency-branded portal for white-label clients' contacts.
- **Social calendar / organic** is a similar approval flow later (the form already includes Organic Social, Google Ads and TikTok).

## 5. Reference data (from files shared 2026-10-13)

- **Account Overview** (Google Sheet): ~102 active, 60 paused and 24 white-label clients.
  - Per-client columns: ID, status, type (Traditional/Whitelabel), POC + other emails, services (M/G/E/Web/Organic/SEO/T), Meta Media Buyer, Google Media Buyer, Graphic Designer, Video Editor, Web Designer, Email Strategist, Social Media Manager, TikTok Buyer, Copywriter.
  - The media-buying tab has the **Meta ad account ID**, creative folder, intake form, KPI and priority tier.
- **Creative KPI board**: per client, **Images Expected / Videos Expected** per month (this is the allotment), images and videos delivered in the last 45 days, **average completion time** (request → internal review), last request date.
- **Creative Submission Form** fields: Client ID · Platform (Meta Ads / Google Ads / Organic Social / TikTok) · Creative Format (Single Image / Video / Carousel, multi-select) · Creative Type (Iteration of an ad / New creative) · Intended Audience · Creative Angle · Request description (long; buyers often paste full multi-brief docs with hooks, funnel stage, sizes, CTA) · *Iteration only:* Drive link of the ad + what to change/test + other notes · "Did the client send over [assets]…".
- **Creative Database** (per client, client-facing): Date · Link to Copy · Link to Creative · Platform · Ad Title · Creative Type · QTY new deliverables · QTY total incl. variations · Version · Revisions completed? · Approval Stage (Ready for Review / Revisions Needed / Approved) · Is this for Meta? · Notes (often "approved through email/Slack") · Status in ad account.
- **Copy sheet template**: Short form (Headline 1–3 ≤40, Primary Text 1–3 ≤125), Long form (same slots), Landing Page URL.
- **Asana "Creative" board** (print of 2026-10-13). Sections in order:
  - **Creative Brief** → **In Progress** → **Creative for Review** (Jesus) → **Ready for Copy** (media buyer) → **Copy for Review** → **Ready for Client** (Jorgi) → **Sent to Client** (Jorgi) → **Client Revision** → **Ready for Launch** (media buyer) → **LAUNCHED**
  - There's no separate internal-revision section; internal sendbacks go back to In Progress.
  - The task is reassigned at each stage.
  - **Task title pattern**: `Platform - Creative Type - Client - Format` (e.g. "Meta Ads - Need a new creative - Sierra Dreams - Image").
  - **Priority is hacked into titles**: "URGENT:", "URGENT: URGENT:", plus a "Priority: HIGH" field.
  - **Tags in titles**: [Founder], [UGC], [AI flagged].
  - **Due dates** on most tasks.
  - **Task body**:
    - Priority, Client ID, Media Buyer, Platform, Type of Creative, Intended Audience, Creative Angle, "Anything specific to focus on" (often a Motion link to the ad to iterate)
    - **REQUIRED AI prompt links**: a video script prompt doc, a single-image prompt doc, a pre-continue checklist, a Loom on how to use the prompt, and a **Claude project for copywriting**
    - If the client has email marketing: the Figma board and email strategist
    - Client quick links: Headquarters, Website, Creative Database
    - The "submit this form when copy AND creative are ready for client review" link
  - **Volume snapshot**: ~140 open tasks. Many are flagged URGENT, and the Sent to Client column is the largest.
  - Assignees seen: Mira Dubovets, Daniel Alvarez, Nelson Ferreira, Victor Cuevas Melayes, Jazem, Hillary Goncalves (creative); Jesús Araujo (review); Dipesh, Priscila Aguilera, Eduarda Telechi, Lais Bhering, Rahul Arora, Aneesa (buyers); Jorgi (client stages).
- **Naming convention** (agreed 10/08): Drive subfolders by **angle or avatar** (e.g. "fresh, never frozen", "focus for moms") and a size suffix on every file (**1x1, 4x5, 9x16**).
