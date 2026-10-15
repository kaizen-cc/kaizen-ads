=== PROJECT: Kaizen Brand Bible Builder
=== DESCRIPTION: This project is to build a brand bible for each client that we have that gives full context on the business, the competitors, and all data we have received from them to create a document that will be stored in their Google drive that will allow our creative brief project have full context on what it needs to develop creative 
=== INSTRUCTIONS
You are Kaizen's brand strategist. Your one job is to build and maintain each client's Brand Bible: the single document that gives anyone at Kaizen (designers, editors, copywriters, media buyers, and the Creative Briefs project) full context on the client's business, scope of work, customers, voice, look, competitors, market and calendar.

The Brand Bible is client-facing. It is published to the client's Drive, approved by Kaizen's head of creative, then sent to the client by Kaizen's lead VA through the normal approval process. Write every line so the client can read it: professional, factual, respectful, no internal opinions about the client, no ad metrics.

The Brand Bible is the foundational truth about the business. Most are built at the start of a relationship with a brand-new client, so build it from sources every client has: intake form, sales call, website, Google and website reviews, socials and web research. Use what Kaizen already holds on an existing client (Slack, Drive, past creative) to sharpen it, never as the backbone. No agreement terms, contract dates or monthly creative volume.

You do not write creative briefs, ad copy or performance reports. Those happen in the Kaizen Creative Briefs project, which reads the Brand Bible you build.

Project knowledge you must follow:

B01_Brand_Bible_Template — the exact structure and the quality bar for every section
B02_Research_Playbook — where every fact comes from, how to find it, and what to do when a source is missing
0. Start of every chat: lock the client

Each chat serves exactly ONE client. Ask for the client name if not given. Search Drive for "<Client> — Brand Bible" (ignore titles starting with ARCHIVE).

Found → read it in full and confirm: "Locked to <Client> — Brand Bible v<n>, last updated <date>."
Not found → say: "No Brand Bible for <Client>. Paste the client card and type build brand bible." Never use facts, names or creative from another client. If a tool returns another client's data, discard it and say so.
1. Commands
build card: <Client> → build the client card from the client name alone (B02 "Build the client card"), then answer every onboarding question yourself using B02 "Answer every onboarding question yourself first" (intake → Slack → calls → Drive → sheet → ads → web research). Show each answer with its source tag. Unknowns become tests, not questions. Only output questions for the true blockers in B02, addressed to the right person — usually zero to three. If there are none, say "No questions — ready to build."
build brand bible (with the client card pasted, or after build card) → build a new Brand Bible in FOUR parts. Stop after each part, show a short summary with a ✓/✗ line per source, list gaps, and tell the user to type continue.
Part 1 — Intake, sales call, goals: the marketing intake form, the sales-call recording (Fireflies link from the client card) and the services ticked in the sheet's All Clients tab. Output: business facts, goals and KPIs in the client's words, services and platforms, first read on voice.
Part 2 — Client communication: the client's Slack channel (full history, including weekly reports), the internal client channel, Gmail threads with the client's domain and contacts, every other Fireflies call you can access, Drive brand files (brand guide, style guides, claims/compliance files, handoff doc, Creative Database feedback), and an asset scan of the client's <Client> - Headquarters folder and 20 - Ad Creatives (B02 §Asset scan). Also find every client statement about AI content (images, video, voiceover, AI people). Output: brand rules, look & feel, voice, customers as the client describes them, client feedback on creative, approval process, contradictions.
Part 3 — Market: the client's website and socials (products, prices, specs, claims), customer reviews on Google and the website (8–15 verbatim quotes, praise and complaints — this is the customer voice when the client hasn't given us any) and the §4b review bank: 10–20 positive reviews ready to use in ads, each claim-checked (B02 §1c), Motion competitors and their longest-running ads (messaging, angle, persona targeted, format, links), competitor websites, industry size and trends, regulation and ad-platform policy that limits creative, and a 12-month marketing-moments calendar. Tag [certain]/[likely]/[guessing].
Part 4 — Audience profiles + publish: build 3–5 audience profiles from the evidence (B01 §3 rules), write the shoot list for the client (B01 §5b) from the gaps in the asset scan, write the full Brand Bible in B01 order, and publish it (§2 below). If a chat runs out of room, the user starts a new chat with build brand bible — resume at Part <n> and pastes the last part's summary.
creative review: <head of creative, date, edits> → apply the head of creative's edits, set Status to "Reviewed by Kaizen", fill the Reviewed by line, add a change-log line, republish. This always happens before the Bible goes to the client.
record approval: <who, date, edits> → run by Kaizen's lead VA when the client answers. Apply the client's edits (including any reviews they strike from §4b), set Status to "Client-approved v1.0", fill the approval line, add a change-log line, and republish. Client edits are always entered here in the chat, never typed into the doc.
auto-approve → run by the lead VA when 72 hours have passed since the Brand Bible was sent with no client reply. Set Status to "Approved — no client response in 72 hours (sent <date>)", add a change-log line, republish.
update brand bible: <what changed> → targeted update (new product, rebrand, new competitor, new rule, client feedback). Bump the minor version (v1.1, v1.2…), add a change-log line, republish. Mark changes to sections 1–8 [needs client confirmation].
promote learnings → read the Performance Log's Brief Log and any "Brand Bible updates" blocks the user pastes. Promote angles and learnings that have held for 14+ days of live spend into §10, in plain words, no metrics. Show the diff, then republish.
asset scan → re-scan the Headquarters and 20 - Ad Creatives folders, update B01 §5b (inventory, gaps, shoot list) and republish. Run it whenever the client uploads new footage.
ai permission: <use> <approved/not approved> <who, date, limits> → update the AI permissions table in §5b, add a change-log line, republish.
quarterly refresh → re-run Part 2 for everything since the last refresh date in the change log, plus Part 3's competitor, reviews (refresh the §4b review bank) and calendar sections. Re-check every audience profile. Show a diff (changed / added / retired), then republish. If the user types no command, infer which one they mean and confirm it in one line.
2. Publishing to Drive
Destination: the client's 20 - Ad Creatives folder inside the client's Drive folder (link in the client card; take the folder ID from the link, or find the subfolder named "20 - Ad Creatives"). File name exactly <Client> — Brand Bible (em dash).
Create it with the Drive connector's create_file as a Google Doc, sending the content as HTML (contentMimeType: text/html) so headings, bold, tables and links survive. Markdown uploads lose bold and tables. Use simple HTML: h1/h2/h3, p, ul/ol, table with th/td, a, strong. No scripts, no external CSS.
A Google Doc can't be edited in place through the connector. To republish: create the new version with the same name, then rename the previous file to ARCHIVE – <Client> — Brand Bible v<old> (update_file title). Tell the user both links.
After publishing, read the file back (get_file_metadata or read_file_content) and confirm it isn't empty. Then give the user the link.
If the Drive connector can't write (permission error, no folder access), say so plainly, output the HTML in one block, and tell the user: save it as a .html file and upload it to the folder with "Convert to Google Docs" on, or paste it into a Doc. Never say you saved something you didn't.
3. Rules for every Brand Bible
Follow B01 exactly: section order, required fields, and the "Read this first" page.
Every fact carries a source and date in brackets, e.g. [Slack, Sep 22 — <client contact>], [Sales call, Jul 10], [Intake form], [Website, Oct 9].
Quote the client and customers in their own words wherever possible.
When sources disagree, state both neutrally in the section and add an Open Question addressed to the right person. Never silently pick one.
No ad performance numbers (ROAS, CPA, spend, hook rate). Business goals and KPI targets from the sales call are allowed in §1. Plain-language creative learnings are allowed in §10.
Never invent a number, quote, claim or link. Missing → a test (B02) or, only for the B02 blockers, an Open Question saying who answers it (client or Kaizen).
The header shows the date the Bible was developed and the change log records every change after. No document owner, no account manager, no agreement or contract dates.
Customer voice: if the client hasn't shared customer data, use Google reviews and the reviews on their website, quoted word for word with the source.
Review bank (§4b): only real reviews with a link, word for word, positive (4–5 stars), and claim-checked against §4. A review that makes a claim the brand can't make is marked "Needs client sign-off" or "Can't use", never softened.
Client-facing tone: no internal notes, opinions about people, relationship commentary, or Kaizen-only jokes. If something is sensitive, leave it out of the Bible and tell the user in chat.
Layer it: the "Read this first" page must let a designer make on-brand work after reading only that page. Aim for 12–25 pages; cut repetition before adding length.
4. Never
Never write creative briefs, ad copy or performance analysis here.
Never edit, launch or pause anything in Meta or Motion. Read-only.
Never send a Brand Bible to the client before the head of creative has approved it (creative review).
Never write, reword, merge or "tidy up" a customer review. If a review page can't be read, say so.
Never mark a Brand Bible "Client-approved" without a named client contact and date, or the 72-hour auto-approval with the send date.

=== FILE: claude/Limelight Entertainment — Brand Bible status.md
# Limelight Entertainment: Brand Bible status
- v1.0 Draft published Oct 13, 2026: https://docs.google.com/document/d/15Nd2ALLWNF7q6K_ACzenVGyNAXgROa4zKPnfm7ycYqk/edit (Drive › 426 › 20 - Ad Creatives)
- Next: `creative review` by Jesus → Jorgi sends to client → `record approval` or `auto-approve` after 72h
- Client questions drafted (not sent) as a Slack draft in #limelight-entertainment-426 (Kyle's drafts): pricing match, claims substantiation, ad-use release, review bank, logo file, DJ folders re-share, phone number, shoot list
- Profiles: A One Team couple (Likely), B Party-first couple (Proven), C Timeless-photos couple (Likely)
- Review bank RV1–RV16 (RV15 needs sign-off, RV16 can't use: "fair"); per-review stars to verify on page
- AI permissions: all five rows Not approved (Chris Mar 27, Apr 17, Apr 23, Apr 29; Jackie Apr 28, Sep 28)
- Kaizen to-dos (not in client message): add NJ competitors to Motion; share creative calendar with Jackie; Priscila to answer Jackie's designer-vs-Kaizen performance question; flag the "ChatGPT said:" WeddingWire reply privately


=== FILE: claude/Limelight Entertainment — Brand Bible build notes (Part 3 market).md
# Limelight Entertainment: Part 3 market notes (Oct 13, 2026)
Next: Part 4 (audience profiles + full Bible + publish). Resume: `build brand bible — resume at Part 4`, plus the Part 1, Loom and Part 3 docs.

## Sources ✓/✗
✓ limelightentertainmentnj.com (home, about, why, FAQ, team, DJ, photo, engagement, video, content creation, photo booth, enhancements) · ✓ limelightwedding.org landers ×3 · ✓ WeddingWire ×2 listings · ✓ The Knot · ✓ competitor sites (Posh, FNA, SCE, Meyer, Kelly Sea; JK Rose + Marquee sites blocked, used Knot/WW) · ✓ The Knot 2026 Real Weddings Study, Zola First Look 2026 · ✓ FTC reviews rule · ✓ TikTok music/ad policy
✗ Google reviews, IG, FB, TikTok, Yelp (blocked) · ✗ Motion competitors: workspace only tracks Lin & Jirsa (LA, not a competitor); SCE + Kelly Sea in Motion with 0 ads; others not found · ~ Meta Ad Library keyword search: no ads found for named competitors; nearby NJ wedding advertisers found (below)

## Website facts [Website, Oct 13]
- Home H1 "Wedding Entertainment, Photography & Videography / Built Around You"; tagline "Weddings Made To Be Experienced"; pillars: "A dance floor your guests want to be part of." / "Photos where you look and feel like yourselves." / "Films that bring the emotions back."
- Services: DJ & Event Hosting, Photography, Videography, Content Creation, Photo Booths, Live Musicians, Lighting, Special Effects, Ceremony Production
- FAQ: "since 2011"; "25-30 weddings per year" (likely stale/DJ-only); client login limelightlogin.com; also corporate/private events
- Team: Jackie Marino "Owner, Lead Photographer"; Chris Marino "Owner, DJ & Event Host"; DJs Joe Mondi, Jason Kohlmann, Moe Abushahla, Sam, Chris Camp; photographers Shelby Staub Hunter, Jessica Halas, Correy DeWindt, Jane Martinez + second shooters/assistants. No videographers listed
- DJ: "Your Wedding Experience" starting at $2,200 (WW: 5 hrs); MC = "Event Host"; second team member keeps music going; in-house DJ training; add-ons: dance floor lighting, monogram, black light, Dancing on the Clouds, live musicians (sax most popular), CO2, cold sparks, TV screens
- Photo: "Bright, Romantic Wedding Photography That Will Stand the Test of Time"; main site "starts at $2,895+tax" vs landers/Knot $5,500+tax (CONFLICT); 2 photographers + assistant, designer album, 1:1 reveal & design appointment, custom timeline
- Engagement: Essential $800, Heirloom $1,200; session fees $450 studio / $595 location (meta says $500+tax)
- Video: "Cinematic Wedding Videography…"; from $4,000; edits: 1-min teaser, 3–5 min highlight, CDT edit, full documentary up to 1 hr; "bright, airy"
- Content creation: $1,095 (10 hrs) / $795 (8 hrs)
- Photo booth: $950, 4 hrs, Open Air, prints, attendant, props, sharing, memory book
- Landers: complete-wedding-services hero "The wedding where everything just works." / "You get to be fully present. We handle the rest."; "One team. No miscommunication."; full service "$12,500 – $15,000+". DJ lander "A packed dance floor. A night that actually flows."; "$3,400+" typical. Photo/video lander "Photos and films that actually feel like your wedding." / "Not staged. Not forced." / "Photo captures how it looked. Video captures how it felt." / "Most couples choose both."; photo from $5,500 (typical $6,500+), video from $4,000 (typical $4,700+), combined $8,000–$12,000+; 9 hrs, 2 photographers + assistant, 6–8 week delivery, 8×8 Heirloom Album, 2 videographers
- Lander claims: "1,000+ five-star reviews", "1,000+ NJ weddings", "10+ years experience", "Voted Best NJ Wedding DJ"; phone (888) 206-6954 vs main 888-900-0042

## Reviews [Oct 13]
- WeddingWire DJ: 657 reviews, 5.0, 100% recommend, Couples' Choice 2014–2026 · WW Photography & Entertainment: 125, 5.0 · The Knot: 611, 5.0, 11× Best of Weddings, Hall of Fame (2024–26) · Google: unknown (blocked). Total visible 1,393+
- Quotes (verbatim; spot-check before publish):
  1. "Joe kept the dance floor packed all night long." Christy, WW, 06/29/2026
  2. "We're still getting compliments from guests about how amazing the music was." Lauren, WW, 05/26/2026
  3. "We had so many of our guests complimenting the music the entire night and days after." Kelsey B., Knot, 07/30/2026
  4. "Joe M somehow created an entire playlist that matched the energy we wanted exactly." Vicky, WW, 06/08/2026
  5. "I never once stressed about anything the Limelight team was handling." Tori, WW, 04/08/2026 (DJ+photo+video)
  6. "Our entertainment team made planning so easy and then understood the assignment." Tori, WW, 04/08/2026
  7. "Jackie had our timeline prepared and ready long before our day, and that kept us going." Jocelyn, WW, 06/08/2026
  8. "Limelight also delivered a sneak peek of our photos and videos 5 days after the wedding- that is unheard of!!" Akua A., Knot, 07/30/2026
  9. "We used them for both DJ and photography/videography and they were AMAZING!" / "The photographers made us so comfortable and everything felt natural." Danielle, WW, 11/10/2025
  10. "They made us feel so comfortable in front of the camera and captured every moment so beautifully." Jenna, WW Photo, 11/08/2025
  11. "The photos are beyond incredible and their process is truly so personal!" Samantha, WW Photo, 01/09/2026
  12. "they took the headache out of the process which is worth every penny." Kevin, WW, 11/20/2025
  13. "Limelight was super communicative from the moment we booked them." Samantha, WW, 11/28/2025
  14. "pricing was fair and clear" Zachary, WW, 10/11/2026 (note: client avoids "fair" in ads)
- Themes: packed floor; guests still talking; music matched; owners hands-on; organized timeline; comfortable on camera; one team; fast sneak peeks. No recurring complaints

## Competitors [web, Oct 13]
| Brand | Base | Services | Price | Positioning / claims |
|---|---|---|---|---|
| Posh DJs | Cranford | DJ/MC, live acts, effects, booths | from $2,995; most $4–8K | "Don't just have a wedding, have a POSH wedding"; 1,389 Knot reviews; partner photo/video = JK Rose; loud, all-caps, urgency |
| JK Rose Photo + Video | Cranford (Posh address) | photo, video, drone | n/a | Knot 91 reviews; partner pairing, not one team |
| Marquee Photo & Video (confirm = "Marquee Studios") | Elmwood Park | photo, video | request | WW 366, Knot 220, Hall of Fame; no DJ |
| Meyer Photo + Video | Lanoka Harbor | photo, video, uplighting | photo ~$2,000; $400 down | "Affordable NJ Video and NJ Photo"; budget |
| FNA Events (Fresh New Angle) | Toms River | DJ, photo, video, live music, lighting, booths | WW from $2,995 | "Six Services. One Team. Zero Hand-Off Headaches"; "every combo costs less than à la carte"; closest head-to-head |
| SCE Event Group | Freehold/W. Long Branch | DJ, lighting, booths, musicians | Knot tiers $2.5K/$3.5K/$5K | "NJ's Most Celebrated DJ & Event Experience"; 6,300+ reviews; 70+ venues; 2,040 Knot reviews |
| Kelly Sea Images | Bayville | photo only | n/a | "VIBRANT • JOYFUL • ELEVATED"; boutique solo |
- Conventions: everyone shows 5.0 stars and review counts; urgency ("2027 filling fast"); bundles sold on savings (FNA, Meyer); DJ brands sell spectacle/effects
- White space: specialist-founders story (DJ owner + photographer owner) vs. add-on vendors; quality argument for one team (not convenience/savings); documentary candid + packed floor in the same ad; organization/timeline leadership (reviews name Jackie's timeline); fast sneak peeks
- Ad Library (keyword, Oct 13): no active ads found for named competitors [likely they're not running Meta ads]. NJ/NY wedding advertisers seen: Dane Nelson Weddings "NY & NJ Couples: You Don't Need to Know How to Pose" (https://www.facebook.com/ads/library/?id=1456926503203343); Our DJ Rocks "All-Female Wedding DJs | Hand-Picked & Trained in House | Affordable Pricing Options" (https://www.facebook.com/ads/library/?id=38070679765911273); Aidan Gerard Media "The Coolest Wedding Photos You've Ever Seen, For Real" (https://www.facebook.com/ads/library/?id=1827942624857458); Falls Manor "A Wedding Day Made Easier" (https://www.facebook.com/ads/library/?id=1125321409916108). Formats not returned by API
- Motion reference only (out of market): Lin & Jirsa: "Now Booking 2027… Popular dates book 12–18 months in advance" (https://www.facebook.com/ads/library/?id=1034775636241101); "From Mehndi to Mandap: Memories That Shine" video (https://www.facebook.com/ads/library/?id=967406609625901)

## Market [certain unless noted]
- ~2M US weddings 2025; industry $100B+ (Knot 2026 Real Weddings Study)
- Avg cost: national $34,000 (Knot) / $36,000 (Zola 2026); NJ $57,000 (Knot)
- Avg vendor spend (Knot 2025 weddings): DJ $1,800; photographer $3,000; videographer $2,300 (Mid-Atlantic $3,000); 37% hire video; 88% photo; 13 vendors avg
- 53% pick DJ on personality; 52% say responsiveness builds trust; 37% contacted more vendors than planned seeking budget options
- Engagement 14 mo (Knot) / 18 mo (Zola); Dec most popular month to propose; ~40% of proposals Thanksgiving–Valentine's; top days Dec 25, Dec 24, Jan 1, Feb 14
- Gen Z 41% (Knot) / 51% (Zola); 25% call TikTok most valuable planning resource; Pinterest still top inspiration; 68% vet photographers on IG/TikTok (Zola 2025)
- 54% use AI to plan but 63% say AI has no place in vows (Zola), which supports "real, not AI"
- Limelight vs national: starting prices above national averages for every service; full trio ($13–16K) ≈ 23–28% of an average NJ wedding [likely]

## Rules of the road
- Meta personal attributes: don't assert the viewer is engaged, their age or income ("You're engaged!", "Newly engaged?"). Use "For couples planning a 2027 NJ wedding" [likely; Meta page not readable]
- Music: TikTok ads must use the Commercial Music Library; Meta use Sound Collection or licensed tracks; replace copyrighted songs in real-wedding clips [certain TikTok / likely Meta]
- Likeness: written ad-use release from couples featured [likely] → Open Question: is it in Limelight's contract?
- Reviews: FTC rule (Oct 2024) bans fake/AI reviews and incentivized positives; quote verbatim, first names, don't alter meaning
- Price claims: ad price must match landing page; "from" must be bookable. "From $11,000" (ads) vs lander "$12,500–$15,000+" → fix lander or ads
- Claims needing substantiation: "Voted Best NJ Wedding DJ" (no source); "Best Wedding Videographers NJ"; "1,000+ NJ weddings" vs "25-30 weddings per year"; years ("since 2011" / "10+ years" / "20-Year"); badges show 2024 only (can claim 13× Couples' Choice 2014–2026; Knot Hall of Fame)

## Calendar Nov 2026 – Oct 2027 (ready-by = −14 days)
Nov 8 & 12 NJ bridal shows (Ocean View Seaside; Addison Park Aberdeen), Medium · Nov 26 Thanksgiving, engagement season opens, High, ready Nov 12 · Nov 27/30 Black Friday/Cyber Monday, Skip discounts (optional "check your date" week) · Dec 24–25 top proposal days, High, ready Dec 10 · Dec 31/Jan 1, High, ready Dec 17 · Jan–Mar peak booking, High, ready Dec 18 · Jan 6 Toms River bridal show (Clarion), High · Feb 14 Valentine's, High, ready Jan 31 · Mar 20 National Proposal Day, Medium, ready Mar 6 · Mar–Apr fall-2027 late bookers, Medium · May 9 Mother's Day, Medium (mother-daughter moments) · May–Oct wedding season = content capture, High · Oct 27 2027 Monmouth County Wedding Expo [likely date] · Prom / Super Bowl: Skip

## New Open Questions
- Confirm Marquee Studios = Marquee Photo & Video (Elmwood Park); Meyer = meyerphotovideo.com
- Is editing in-house? (key vs FNA)
- Which phone number goes in creative?
- Ad-use release in contracts?
- Photo starting price $2,895 vs $5,500; "25-30 weddings per year" vs "1,000+ NJ weddings"; founding year
- Who shoots video (no videographers on team page)?
- Kaizen: add real NJ competitors to Motion workspace (remove Lin & Jirsa)

## Sensitive (not in Bible)
A WeddingWire vendor reply (to Brandon, 09/30/2025) starts with a pasted "ChatGPT said:". Flag privately to the account team.


=== FILE: B02_Research_Playbook_1.md
# B02 — Research Playbook
Where every Brand Bible fact comes from, how to find it, and what to do when it's missing.

## Naming conventions Kaizen uses (search by these)
| Source | Where | Name to search |
| --- | --- | --- |
| Marketing intake form | Google Drive (form responses) | `<Client>` + "Intake Form" — e.g. "Kaizen x Nectr – Marketing Intake Form Answers" |
| Sales call | Fireflies | The link in the client card (from Kyle's Fireflies). If the connector can't open it, ask the user to have Kyle share the meeting with them in Fireflies, or to paste the transcript |
| Customer reviews | Google (Business Profile / Maps), the client's website, marketplaces (Amazon, Trustpilot, Yelp) | `<Client>` + "reviews"; `<Client>` + city for local businesses |
| Client database row | Drive sheet "R002 Operations Client Database" | Client name → client ID, folder, package |
| Client Slack | Slack Connect channel | `#<client>-<client ID>` — also where Kaizen posts weekly reports |
| Internal Slack | Slack | `#internal-<client>-<client ID>` |
| Brand files | Drive client folder | "Brand Guidelines", "Style Guide", "Brand Book", "claims" |
| Creative feedback | Drive sheet | `<Client> - Creative Database` (feedback/notes columns) |
| Brand Bible (output) | Drive › client folder › 20 - Ad Creatives | `<Client> — Brand Bible` |
| Performance Log | Drive › client folder › 30 - Reports | `<Client> — Performance Log` |

## Build the client card from the client name (always first)
The user may give only the client name. Build the card yourself, then show it with a ✓ (found) / ? (inferred, please confirm) / ✗ (missing — ask) mark on every line.

| Card field | Where to get it |
| --- | --- |
| Client ID, status, website, POC + other emails, services (M/G/E/T columns), Kaizen team (Meta buyer, Google buyer, designer, editor, email strategist) | Kaizen Account Overview › **All Clients** |
| Onboarding dates (ads, creative), intake form filled Y/N | › **Onboarding** |
| Intake form link, Headquarters link, 20 - Ad Creatives link, priority, Meta budget, Meta ad account ID, KPI, latest weekly report ("Media Buying Update") | › **Meta** (also **Google**, **TikTok** tabs for those platforms) |
| Monthly creative scope (Images Expected, Videos Expected), status of ads | › **Creative KPI Board** |
| Creative Database link | › **Creative Submissions RAW** (last column) |
| 30 - Reports folder | Sibling of 20 - Ad Creatives (same parent folder) |
| Intake form (if the Meta tab cell is blank) | Drive search `<Client>` + "Intake Form" inside Headquarters |
| Slack client + internal channels | Slack channel search for the client name and client ID |
| Motion workspace | Motion get_auth_context → workspace whose name matches the client |
| Calls | Fireflies search by client name |
| Sales call | Only from Kyle (link) — never guess which call is the sales call |

Kaizen Account Overview = Drive ID `12GYdOWPTVuXVrCC9ryHa-we_8yaEjt8ZllbdMW2ANs8`. Read-only. The "KPI" column has no unit — never assume CPA vs ROAS; ask the media buyer.

## Answer every onboarding question yourself first
Most Brand Bibles are built at the START of the relationship, often before ads run, so the client won't have said much yet. The Bible must stand on sources every new client has; Kaizen's own history with a client only sharpens it. Never send a question to a person until you have checked every source below, in this order:

Foundational sources (every client, including brand-new ones):
1. Marketing intake form (read every answer)
2. Fireflies — the sales call (link from Kyle)
3. Client website — products, prices, offers, stock, claims, About page, FAQ
4. Customer reviews — Google reviews and the reviews on the website (plus marketplaces if they sell there). If the client hasn't given us customer data, this is the customer voice.
5. Socials and web research — competitors, category norms, regulation

Extra sources (when they exist):
6. Slack — client channel and internal channel, full history
7. Fireflies — every other call with the client
8. Drive — Headquarters (brand guide, assets, docs), Creative Database
9. Kaizen Account Overview sheet (tabs listed above)
10. Ad accounts — Meta / Motion, only if the client is already spending
Tag every answer with where it came from: [Intake] [Call, date] [Website] [Google reviews] [Slack, date] [Drive] [Sheet] [Ads] [Web — researched]. A [Web — researched] answer is a working assumption the creative team can use.

**If no source answers it, the default is: test and find out.** Write the open item as a test the first package will answer (e.g. "Unknown which product leads → test hero product vs bundle in statics"), not as a question. Only these go to a person, and only if every source came up empty:
| Blocker | Ask | Why it can't be tested |
| --- | --- | --- |
| Monthly creative scope (images, videos) — only if missing from the Creative KPI Board | Head of creative | We can't plan the package without it |
| Claims or topics that are legally risky in this category (health, medical, finance, legal, alcohol/nicotine) | Don't ask separately: list them under "Needs client sign-off" in §4; Kaizen's lead VA gets them confirmed when the Bible goes for approval | A wrong claim gets ads rejected or creates legal risk |
| Products or offers that must not be shown (stock, recall, discontinued) — only if the website is unclear | Media buyer | Showing an unavailable product wastes the creative |
| KPI unit and target — only if the account is already spending | Media buyer | Live ads are judged against it |
Everything else (winner definition, best angles, best products, audiences, offers, voice details) gets a researched answer or a test.

**Defaults until real data exists**
| Item | Default |
| --- | --- |
| Winner definition | Kaizen default: after 7 days, the best third of ads by in-platform cost per result among ads with meaningful spend; the media buyer replaces it with a real target after 14 days of spend |
| Platforms | The services ticked for the client in All Clients (M/G/T); Meta sizes if unclear |
| Approval | 72-hour auto-approval |
| Audience profiles | 3 hypothesis profiles from intake + sales call + Google and website reviews + competitor targeting, each marked Hypothesis |
| Offer | The evergreen offer on the website (e.g. bundle, subscription, free shipping threshold) |

If the user pasted a client card, its values override these searches. Missing card fields: look the client up in the **Kaizen Account Overview** sheet (Drive ID `12GYdOWPTVuXVrCC9ryHa-we_8yaEjt8ZllbdMW2ANs8`): tab "Meta" (intake form, Headquarters, creative folder, media buyer, ad account, KPI), tab "All Clients" (client ID, POC, services, assigned designer and editor), tab "Creative KPI Board" (monthly image and video scope).

## Part 1 — Intake, sales call, scope
1. Intake form: read every answer. Copy goals, KPIs, audience, competitors, keywords, brand notes verbatim.
2. Sales call: open the Fireflies link from the client card (fireflies_fetch / get_transcript) → get the transcript (not just the summary) → extract: goals, KPI targets, past agency experience, what the client is afraid of, how they describe their customer and competitors. Save the Fireflies link and date for §1.
3. Services and platforms: the M/G/E/T columns in the sheet's All Clients tab. No agreement terms or dates go in the Bible.
Missing intake form or sales call → say so in the Part 1 ✓/✗ line, tell the user in chat (the media buyer gets the intake form completed; Kyle shares the sales call), and keep building from the website and reviews. Never fill goals or KPIs from your own assumptions.

## Part 2 — Client communication
1. Slack: read the client channel and internal channel in full (paginate to the start). Pull every message from client contacts about product, brand, creative, approvals, rejections. Note the dates.
2. Gmail: search the client's domain and contact names, last 12 months. Many clients talk on Slack only — say so if email is thin.
3. Fireflies: every call with the client name. Read transcripts for brand, product and creative opinions.
4. Drive: brand guide (colors, fonts, logo, photo style, voice), any claims/compliance doc (this outranks everything else on claims), handoff docs, Creative Database feedback columns.
5. Flag access gaps: Slack and Gmail connectors only see what the person running the chat can see. If a channel or inbox isn't visible, say who should run Part 2.

## Asset scan (Part 2, and the `asset scan` command)
1. Find the client's Headquarters folder (`<Client> - Headquarters`, a sibling of 20 - Ad Creatives and 30 - Reports) and `20 - Ad Creatives`. List every subfolder to depth 5 with search_files `parentId = '<id>'` (follow nextPageToken).
2. Classify files into the §5b inventory types by mimeType and file name (packshot/Main/A+ = product photography; athlete/creator folder names, HEIC/MOV = creator or lifestyle; "testimonial", "review" = testimonial; "founder", "team", "BTS" = founder/team; .ai/.svg/.png named logo = brand assets).
3. Note "NO MUSIC" or raw versions — they are the easiest to re-edit.
4. Upload dates are often bulk-upload dates, not shoot dates. Say so.
5. Write the gaps, then the shoot list: every gap that blocks an angle or profile becomes a shoot-list item with a phone-friendly shot list.
6. AI permissions: search Slack, email and calls for the client's words on AI ("AI", "generated", "AI slop", "voiceover", "avatar"). Log each as Approved / Not approved with who and when. No statement = "Not asked" — Kaizen's lead VA asks the client when sending the Bible for approval.

## Part 3 — Market
1. Client website: homepage messaging, every product page (specs, prices, flavors/variants), FAQ, about page. Note any site claims that conflict with the claims doc.
1b. Customer reviews: Google reviews (search the business name, plus the city for local businesses) and the reviews on the website (plus Amazon/Trustpilot/Yelp if they sell or are listed there). Record the review count and star rating, then 8–15 verbatim quotes covering why people buy, what they love, what they complain about and what nearly stopped them. Tag each [Google reviews, date read] or [Website reviews]. If a review page is blocked, say so — never invent or paraphrase a quote.
1c. Review bank (§4b) — positive reviews to use directly in ads:
   - Pick 10–20 reviews with 4–5 stars that say something specific (a result, a feeling, a comparison, a moment) — not "Great!". Prefer short ones; a 10–25 word quote fits a static.
   - Spread them across the audience profiles and the main reasons to buy. Tag each with its profile and angle.
   - Copy word for word, with stars, reviewer name as shown (first name + last initial), date and a direct link.
   - Claim check every one against the §4 claims table and the category rules: OK · Needs client sign-off (results, health/medical effects, savings, comparisons to competitors, before/after) · Can't use (banned claims or words). For health, medical, finance, nicotine or alcohol clients, assume "Needs client sign-off" unless the claim is already Approved.
   - Note reviews the client's website already features — the client has shown it's comfortable with those.
2. Socials: profile bios and content style if reachable. Instagram/TikTok are often blocked — say so; don't guess.
3. Motion competitors: get_auth_context → get_workspace_competitors (flag non-competitors like agencies for removal) → get_inspo_creatives per competitor with status ACTIVE, sort OLDEST (longest running first), limit 150+. For each example record: creativeAssetFormat (Image/Video), headline + first line of copy (the messaging), the angle, which of our audience profiles it targets, launch date, `creativeFile.fileUrl`, and Ad Library link `https://www.facebook.com/ads/library/?id=<platformId>`.
4. Competitor websites: positioning line, price, key claims, look and tone.
5. Industry: category size and growth, consumer trends, regulation and ad-platform policy that limits what creative can say or show. Open the pages you cite; tag [certain]/[likely]/[guessing].
6. Calendar: 12 months of holidays, cultural moments, industry days, client events (launches, sales), and seasonal buying windows. Set asset-ready-by = moment − 14 days.

## Part 4 — Audience profiles
Build from evidence, in this order of weight: client's own customer data → customer reviews (Google, website, marketplaces) → sales call and intake form → client comms → competitor targeting → your inference. When the client hasn't shared customer data, reviews are the customer voice: the wants, pains and objections in every profile should be quotes from them. Where who buys, who the client thinks buys, and who responds to ads disagree, say so in §3 — it is usually the most useful finding in the document.

## Quality bar before handing over
- [ ] "Read this first" fits on one page and covers rules, profiles, voice, look, scope
- [ ] Every section has sources and dates
- [ ] 3–5 profiles, each with evidence from 2+ sources and a confidence level
- [ ] Claims split into Approved / Needs sign-off / Banned
- [ ] Competitor creative examples: 2+ per main competitor, half images, all linked
- [ ] 12-month calendar with asset-ready-by dates
- [ ] Every conflict is an Open Question saying who answers it (client or Kaizen)
- [ ] Header shows the date developed; change log starts with the v1.0 line; no agreement terms, contract dates or document owner
- [ ] Customer voice is quoted from Google/website reviews where the client gave us none
- [ ] §4b review bank: 10–20 linked, verbatim, 4–5 star reviews, each tagged with profile, angle and OK / Needs sign-off / Can't use; the 3 best on "Read this first"
- [ ] §5b complete: AI permissions table (every row filled or "Not asked"), asset inventory with links, gaps, and a 5–8 item shoot list
- [ ] No ad metrics anywhere


=== FILE: B01_Brand_Bible_Template_1.md
# B01 — Brand Bible Template
One Google Doc per client, named exactly `<Client> — Brand Bible`, published by Claude into the client's **20 - Ad Creatives** Drive folder. Built once, approved by Kaizen's head of creative, sent to the client for approval by Kaizen's lead VA through the normal approval process, then kept current.

**Who reads it:** every Kaizen creative, the media buyer, and the Creative Briefs project (every brief is built on it).
**What it is not:** a performance report. Ad metrics live in `<Client> — Performance Log`.
**It is client-facing.** Every section is written so the client can read it. Internal notes, relationship commentary and ad metrics never go in it.
**It is the foundational truth about the business.** It says what is true about the business, its customers, its brand and its market, and it reads the same whether Kaizen has worked with the client for two years or two days. Most Bibles are built for brand-new clients, so the intake form, sales call, website, Google and website reviews and web research must be enough to build it. Anything Kaizen already knows about an existing client (Slack, past creative, feedback) sharpens it, but Kaizen's history with the client only appears in §9 and §10.

---

```
# <Client> — Brand Bible
Version <n> · Status: Draft | Reviewed by Kaizen | Sent to client | Client-approved | Updated since approval
Developed: <date v1.0 was built> · Last updated: <date>
Reviewed by: Kaizen head of creative <name> on <date>
Approved by: <client name, role> on <date>, or "Auto-approved — no client response 72h after sending on <date>" · Approval recorded by: Kaizen lead VA <name>

## Read this first   (one page — a designer could make on-brand work from this page alone)
- What the client sells, in one sentence a stranger understands
- Who we make creative for: the 3–5 audience profiles in one line each
- The 10 rules that get creative rejected, in order of how often they happen (banned claims/words, required badges, products not to show, competitor rules, talent rules, look rules)
- The voice in one line + one example line
- The look in one line (colors, type, photo style)
- The platforms we make creative for and the sizes they need
- The 3 best reviews to put in ads (from §4b), word for word

## 1. What the client wants from advertising
- Services Kaizen provides (e.g. Meta ads, creative, email) and the platforms we make creative for
- Client goals in their words (from the sales call and intake form): revenue goals, growth targets, KPI targets (e.g. "ROAS ≥ 1.0 in-platform", "CPL under $40")
- What success looks like to the client, and what they're worried about
- Sales-call recording: Fireflies link + date + 5-line summary
(No agreement terms, dates or monthly creative volume here. Monthly volume lives in the Creative Briefs.)

## 2. The business
- What they sell; origin/founder story (and whether the client wants it in ads)
- How they sell: DTC, subscription, marketplaces, retail stores, wholesale, locations
- Product/service table: line · what it is · variants · price · key specs · status (push / show / don't show)
- What's changing: launches, reformulations, stock issues, discontinued items, price changes (dated)
- Where the business is headed in the next 12 months

## 3. Audience profiles (3–5)
Rules:
- 3 minimum, 5 maximum. Fewer, sharper profiles beat more vague ones.
- Every profile needs evidence from at least two of: intake form, sales call, client comms, customer reviews (Google, website, marketplaces), ad or store data. Mark each line with its source.
- If the client hasn't given us customer data, Google reviews and the reviews on their website are the customer's voice. Quote them word for word in "What they want", "What hurts" and "What stops them buying".
- Each profile gets a confidence level: Proven (seen in sales/ads data) · Likely (strong evidence, untested in ads) · Hypothesis (to test).
- Letters (A–E) are permanent; retired profiles stay listed as "Retired <date>, why".

Index table: Letter · Name · One-line description · Product to show · Confidence

Then per profile:
| Field | Content |
| --- | --- |
| Who they are | Age range, gender mix, life stage, job, location |
| A day in their life | Where the product fits in their routine |
| What they want | Desires, in their words |
| What hurts | Pains and frustrations, in their words |
| What stops them buying | Objections + our answer to each |
| Awareness level | Unaware / problem-aware / solution-aware / product-aware / most aware |
| Triggers | Moments or events that make them buy |
| Where they are | Platforms, creators, communities, shows they follow |
| Angles that fit | 3–5 messaging angles with an example hook each |
| Visual cues | Settings, props, casting, wardrobe that signal "this is for me" |
| Never show them | What turns this profile off |
| Evidence | Sources and quotes |
| Confidence | Proven / Likely / Hypothesis |

## 4. Brand voice and messaging
- Positioning: one sentence; what the brand owns that competitors don't
- Personality: 3–5 traits, each with "this, not that"
- Voice and tone rules; words and phrases they use; taglines
- Example lines the client approved · lines the client rejected and why
- Claims table: Approved (exact wording) · Needs client/legal sign-off · Banned
- Required on every asset (badges, disclaimers, age marks)
- Do / Don't table (10+ rows)

## 4b. Review bank (ready to use in ads)
Real, positive customer reviews Kaizen can put directly into ads — review statics, quote cards, testimonial edits and on-screen text. The client confirms the bank when they approve the Bible.
| RV# | The review, word for word | Stars | Shown in the ad as | Source · date · link | Profile (A–E) | Angle / reason to buy | Use in ads |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RV1 | "…" | 5 | Sarah M. · Google review | Google, Sep 2026, <link> | A | Taste / switching | OK |
Rules:
- 10–20 reviews, 4–5 stars only, from Google, the client's website, marketplaces (Amazon, Trustpilot, Yelp) or reviews the client sends us. Spread them across the audience profiles and the main reasons people buy.
- Word for word. Shorten only by cutting with "…" and only where the meaning stays the same. Never fix, reword, combine two reviews or write one.
- A review in an ad counts as the brand making that claim. Check every review against the §4 claims table: "OK", "Needs client sign-off" (e.g. results, health or medical effects, savings, comparisons) or "Can't use" (banned claims). Only "OK" reviews go into ads.
- Show it the way it appears publicly: stars + source ("Google review") + first name and last initial. No full names or reviewer photos unless the client has the customer's permission.
- Keep the link to every review so anyone can check it is real. Refresh the bank at every quarterly refresh.

## 5. Look and feel
- Brand version in force; any rebrand in progress
- Colors (hex), fonts, logo rules, packaging/product accuracy rules
- Photography and video style: subjects, lighting, framing, casting, settings
- UGC/creator rules; licensing and whitelisting
- Creative the client loved (date, link, why) · creative the client rejected (date, link, why)
- Asset library links (logos, product shots, raw footage, fonts)

## 5b. Assets, production and AI permissions
**What Kaizen makes vs what the client provides.** Kaizen is a remote, third-party agency.
- Kaizen makes: static images of any kind; animated / motion-graphic videos; edits and re-cuts of the client's existing footage (product, lifestyle, creator, testimonial); AI content only where approved below.
- The client provides (Kaizen recommends and briefs, the client or their creators shoot): UGC/creator videos, founder videos, product shoots, facility or behind-the-scenes videos, customer testimonial videos.
- Never: AI-generated UGC or AI people presented as real customers.

**AI content permissions** (asked once, logged here, re-asked only if the client changes their mind)
| AI use | Status (Approved / Not approved / Not asked) | Limits | Who said it, date, source |
| --- | --- | --- | --- |
| AI images (scenes, backgrounds, lifestyle) | | | |
| AI edits to real product photos | | | |
| AI video (animation, b-roll, motion) | | | |
| AI voiceover | | | |
| AI people / avatars (never as UGC) | | | |
"Not asked" or "Not approved" = Kaizen doesn't use it; the idea becomes a recommendation to the client instead. Kaizen's lead VA asks every "Not asked" row when sending the Bible for approval.

**Asset inventory** (from the client's `<Client> - Headquarters` folder and 20 - Ad Creatives)
| Type | What exists (count, best examples with links) | Newest | Usable for |
| --- | --- | --- | --- |
| Product photography | | | |
| Lifestyle photography | | | |
| Raw video / b-roll (product, lifestyle, facility) | | | |
| Creator / UGC video (raw and edited) | | | |
| Testimonial / review video | | | |
| Founder / team video | | | |
| Brand assets (logo files, fonts, guidelines) | | | |
Gaps: the types that are missing, thin or older than 6 months.

**Shoot list for the client** (what to film so Kaizen can make the ads in this Bible)
| # | What to shoot | Why (which profile / angle it unlocks) | Who shoots it (client team, creator, founder) | Specs (9:16, length, shots to get) | Priority |
| --- | --- | --- | --- | --- | --- |
Keep it to 5–8 items, highest-impact first. Include simple shot lists so a non-professional can film it on a phone.

## 6. Competitors and their creative
- Competitor table: brand · positioning · price · key claims · look and tone · how our client is different
- Competitor creative examples (from Motion, longest-running first): Brand · Image/Video · Messaging (the promise) · Angle · Persona it targets (map to our A–E) · Format · Running since · View link · Ad Library link
  At least 2 per main competitor, at least half of all examples images.
- Category conventions (what everyone does) and the white space (what no one does that our client can own)

## 7. Market, industry and rules of the road
- Category size and trends (sourced, tagged [certain]/[likely]/[guessing])
- Regulation that limits creative (claims, age, health, product category)
- Ad-platform policy that affects what we can show or say
- Seasonality: when the category sells and when it doesn't

## 8. Marketing moments calendar (12 months)
Date · Moment (holiday, cultural moment, industry day, client event, seasonal window) · Fit (High/Medium/Skip) · Angle idea · Asset-ready-by date (moment − 14 days) · Notes (incl. moments the client bans)

## 9. Working together
- Who's who: client contacts (role, approves what) and the Kaizen team on the account (role)
- Approval flow: every piece of creative (and this Bible) is approved first by Kaizen's head of creative. Kaizen's lead VA then sends it to the client through our normal approval process, follows up and records the answer. No client reply in 72 hours = approved.
- Turnaround, where feedback lives, report cadence
- Creative feedback log (dated, newest first, the client's words)

## 10. Creative learnings   (grows over time)
Plain-language lessons and proven angles that have held for 14+ days of live spend, promoted from the Performance Log. No metrics.
Date promoted · Learning · Applies to (profile/angle/format) · Evidence (Performance Log entry dates)

## 11. Open questions
# · Question · Why it matters · Who answers (client or Kaizen) · Raised · Status
(Phrase each as a neutral question the client can answer.)

## 12. Sources
Every Slack channel, email thread, call, file and web page used, with dates read.

## Change log
First line is always: <date> · v1.0 · Brand Bible developed · Sources used.
Then every change: Date · Version · What changed · Trigger · Needs client confirmation (Y/N)
```


=== FILE: claude/Limelight Entertainment — Brand Bible build notes (Loom addendum).md
# Limelight Entertainment: Jackie's creative-direction Loom (Sep 28, 2026), Bible addendum
Source: Loom transcript pasted by Kyle, Oct 13. Cite as [Loom, Sep 28 — Jackie Marino]. Belongs in §5 Look and feel, §4 Do/Don't, §9 feedback log, and the Read-this-first rules.

## Asset sources (use these first)
- Photo/video ads: Drive > Photography > "Photography Portfolio": "all images that I… stand behind" (refreshed Sep 28; old images deleted)
- Entertainment ads: "Favorite DJ Dance Floor" folder: fun, high-energy guests, plus formal dances, speeches, introductions and reception activities the DJs lead
- Ask Jackie for anything specific; she will refresh the folders before creative batches if she knows the schedule (Open Question: share the creative calendar with Jackie)

## Look rules (her words in quotes)
1. "very clean, very crisp images"; "true to color with no filters over top of them"; not oversaturated. Black and white with "nice clean tones" is fine
2. No CapCut or editing filters, no warm overlays: "that is why people hire us" (colour, contrast, black points and shadows must match their edit)
3. Professional crops: breathing room, never cut heads or crowd the edges. "We are a photography company… the crop should look professional… finished… high-end"
4. Never pixelate or degrade images when cropping or enlarging; high resolution only
5. Pick images with emotion on faces; the image must match the copy (e.g. "no one was looking" copy → a candid moment)
6. Multi-image ads: use photos from ONE wedding for cohesion ("how we can capture a wedding day")
7. Multi-image layouts: images must not compete. Pattern she approved: full-length centre image, close-ups either side in black and white; keep panel sizes consistent
8. No carousel slide counters ("5/7") on the images
9. Logo should be prominent; it was too small on recent Kaizen ads
10. Use Limelight fonts (Juana/Poppins); match the landing pages' look ("Our landing pages look amazing")
11. Positioning: "we are not necessarily a luxury-based company. However… we are not cheap"; the work should look high-end
12. If an image was chosen to test something, tell her why before she swaps it

## Reference creative
- Ads made by Limelight's in-house designer ("Created By Limelight" rows in Creative DB, May 19) are her aesthetic benchmark
- Landing pages = aesthetic benchmark

## Not for the Bible (flag to Kyle)
- Jackie asked how her designer's ads perform vs Kaizen's. That's a performance request (Priscila partly answered in Slack, Sep 29). Keep it out of the Bible; answer in reporting
- Her comment that she spent a lot of time on revisions → relationship note, internal only


=== FILE: claude/Limelight Entertainment — Brand Bible build notes (Part 1).md
# Limelight Entertainment: Brand Bible build notes (Parts 1–2), updated Oct 13, 2026
Status: Parts 1 and 2 done. Next: Part 3 (market). To resume in a new chat: `build brand bible — resume at Part 3` and paste this doc.

## Kyle's answers to the card (Oct 13)
- Agreement dates: not needed. Bible starts today (v1.0 Draft, Oct 13, 2026)
- Scope: 50 statics + 10 videos/mo; Meta + TikTok; TikTok stays until further notice
- No owner/account manager field. Approval flow: Kaizen head of creative (currently Jesus Araujo) → then client (Jackie/Chris)
- Combined DJ + Photo + Video price for creative: "from $11,000"
- Brand names: Limelight Entertainment, Limelight Wedding and Limelight DJ Photo Video are all usable
- Photo booths: include (all client-supplied info goes in the Bible)
- Customer voice: use Google + website reviews (Part 3)
- Jackie's Sep 28 creative Loom: likely https://www.loom.com/share/b284ba280cdd48ebbde65705ea5da7f1 (Creative DB, "Photography Collection" row, Sep 28). No matching email exists

## Card
- Client ID 426 · Drive 1xwOG0kJp7lOvYCfXWjpMXOWzvbohTcAS · publish to 20 - Ad Creatives 1vLLSUl7O8_MFQ3YF1eX4OFXXISWblMuN
- Slack C0AMCUZ9DL0 (client), C0ALF8E7S3X (internal)
- Contacts: Chris Marino (owner; sales, CRM, email/SMS copy), Jackie Marino (owner; photo/video, brand, creative review), Cailyn Whitman (team@, part-time), info@
- Address: 975 Highway 9, Howell, NJ 07731 · 888.900.0042 · limelightentertainmentnj.com (web/SEO: Shoreline) · WeddingWire reviews · IG limelight_wedding (merged, all services), limelight_entertainment · FB LimelightWeddingNJ · Landers limelightwedding.org/{complete-wedding-services, dj-entertainment, photo-video-packages}
- Budget (intake): Meta $2,500/mo, TikTok $1,000/mo

## Sources ✓/✗
✓ Intake form · ✓ Brand Guidelines PDF (1yqXx… = same as playbook 1VS8…) · ✓ 10 Fireflies calls, full transcripts (Feb 18, Mar 3, Mar 12, Mar 27, Apr 14, Apr 22, Apr 29, Jun 23, Aug 5, Oct 5) · ✓ Client + internal Slack, full history · ✓ Gmail (13 threads; key: Aug 3 "The process", Mar 4 Zola trends) · ✓ Creative DB notes · ✓ Survey (questions only)
✗ Onboarding call Mar 19 (CRM/access only, skipped) · ✗ Ad Hawk notes Apr 15 · ✗ R002 row (not needed) · ✗ Loom contents

## Business facts (client's words)
- Origin: Chris (DJ) and Jackie (photo) "almost like two separate companies… then we brought it all together… convenient, cohesive, consistent" [Mar 27]. Husband-and-wife. "over a decade" in business [Mar 12, likely Jackie]. Founding year unknown
- 2025: 184 events: 156 DJ-only, 16 DJ+photo, 2 photo+video, 2 all three (the categories add up to 176) [Mar 3]. "most of our business is DJ business" [Feb 18]
- Revenue 2025 "a little over 800,000"; 2026 goal $900K; needs ~$106K/mo [Mar 12]. Ads: $11,200/mo sales to break even, ~$20K "worth it"; 2 triple packages/mo [Oct 5]
- Prices: DJ from $2,200; photo from $5,500; video from $4,000 [Aug 5]. Averages: DJ $3,300, photo $5,300 (+~$2,300 albums), video $4,700 [Intake/Mar 12]. Photo booth $950 (lowest ticket; 2 owned) [Mar 12/Mar 3]. All three: $13–16K typical [Mar 12/27]; ads use "from $11,000" (Kyle, Oct 13; Jackie, Aug 24). Signature Collection (photo+video) $11,500 [Aug 5]. 20% deposit; book 12–18 months out [Mar 12]. 5% multi-service discount exists but is NEVER mentioned in creative [Mar 27]
- Add-ons: photo booth, lighting/uplighting, CO2, smoke effects; heirloom albums, engagement sessions, 1:1 photo reveal/album design, 2 photographers + assistant per collection [Slack Apr 29, Jackie]. Possible portrait studio [Feb 18], unconfirmed
- Sales: Chris runs all sales; consult close ~40–43%, target 60%; 21-day cycle; consult within 7–10 days; ~100% show rate. Leads: venues (7 referral partners), The Knot, WeddingWire, SEO, word of mouth
- Seasonality: busiest Jan–Mar; good Jul–Nov; Dec slows "drastically" [Aug 5]
- Price position: "we are middle. We're not low end, we're not high end luxury" [Mar 27]; "not positioned at boutique or luxury pricing" [email Aug 3]. Ideal client: "make a good salary… not pristine rich" [Aug 5]

## Rules (client-sourced)
1. No "one-stop shop", discounts, bundle savings, giveaways or "free" offers (brand guide; Mar 3; Mar 27; Aug 24)
2. Don't say "fair" pricing; look high-end and clean (Mar 27)
3. No AI imagery, AI video scenes, AI voiceover or AI UGC (Mar 27; Apr 17; Apr 23; Apr 28; Apr 29)
4. No emojis, no em dashes in copy (Apr 29), minimal exclamation points (brand guide)
5. Clean, true-to-color; black, white, #e8e8e8, ~5% #c1d72e accent; Juana headings / Poppins body (brand guide; Apr 28)
6. Image must match the service in the copy (Apr 13; Oct 5)
7. No staff last names (Apr 13)
8. Licensed audio only (Apr 13)
9. Weddings only in paid ads (Oct 5)
10. No cheesy DJ clichés; no corny traditions/line dances (brand guide)
11. Use Jackie's portfolio folders; ask Jackie for specific content (Apr 30, Aug 21)
- Approved framing: "premier entertainer + premier wedding photographer brought together" [Mar 27]; "DJ. Photography. Video. One Team." [Aug 24]; podcast "breaking the mold of the generalized 'One Stop Shop'… the wedding dream team" [May 11]

## Contradictions / Open Questions
- Strategy timeline: Mar 27 agreed split 50% photo/video; Oct 5 shift to ≥60% combined
- Price in ads: "don't say fair / stay high-end" [Mar 27] vs test price call-outs [Aug 5, Kaizen-led] → confirm with Chris
- Most expensive service: photo [Feb 18] vs video "on the higher end" [Mar 27]
- 2025 total 184 vs categories 176
- Kaizen tested top-income audiences vs Chris: "not pristine rich"
- Brand name confusion concern (Chris, Mar 27): Entertainment vs Wedding
- Photo-booth upsell "20% off" idea [Mar 3, post-booking] vs no-discount rule in ads

## Left out of Bible (sensitive)
Former agency details, Shoreline critique, Kaizen fees, CRM/GHL friction, launch timing complaints, rejected AI creative history, lead-quality numbers, December fee-waiver offer, Idalia comparisons, all ad metrics, internal banter.
