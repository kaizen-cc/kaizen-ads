// The Tracking Engineer's starting playbook: one document per area, filed to the agent's knowledge (role:
// tracking_engineer) so each call reads only the parts that match what it's doing. Written as Kaizen's working
// standard from the platforms' own developer documentation (each section names its sources); the agent's YouTube
// channels and what execs and the Heads of Meta and Google teach it keep it current. Plain data: seeded once by
// src/lib/tracking-agent.ts (seedTrackingPlaybook), never overwritten after (edits happen in Settings › AI agents).

export type PlaybookDoc = { name: string; title: string; summary: string; keyPoints: string[]; sources: string[]; text: string };

export const PLAYBOOK_VERSION = "2026-11-20";

export const TRACKING_PLAYBOOK: PlaybookDoc[] = [
  {
    name: "Tracking playbook: Meta Pixel and Conversions API",
    title: "Meta Pixel + Conversions API (CAPI)",
    summary: "How Kaizen sets up and checks Meta's browser pixel and server-side Conversions API: deduplication, Event Match Quality, domain verification and event configuration, and how to diagnose double counting and missing purchases.",
    keyPoints: [
      "Run the Pixel and CAPI together (redundant setup); dedupe with the same event_name + event_id on both",
      "Event Match Quality: send hashed em/ph plus fbp, fbc, client IP and user agent; aim for 6+ on Purchase",
      "fbc must be built from the fbclid when the _fbc cookie is missing; never invent one",
      "Verify the domain in Business Manager; configure the events that matter on it",
      "Events Manager › Test Events and Diagnostics are the first place to look",
    ],
    sources: ["https://developers.facebook.com/docs/marketing-api/conversions-api", "https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events", "https://www.facebook.com/business/help/765081237991954", "https://developers.facebook.com/docs/meta-pixel"],
    text: `META PIXEL AND CONVERSIONS API: KAIZEN STANDARD

1. The setup we want
- Browser Pixel AND the Conversions API (server events) for every conversion event that matters (Purchase, Lead, CompleteRegistration, Schedule, InitiateCheckout, AddToCart, ViewContent). Meta calls this a redundant setup: the server event survives ad blockers, Safari/iOS limits and consent banners; the browser event carries fbp/fbc and context.
- Ways to send CAPI, best first for our clients: the platform's native integration (Shopify's Facebook & Instagram app at "Maximum" data sharing, GoHighLevel's Meta CAPI integration, WooCommerce official plugin), a server-side GTM container (Stape or Google Cloud) with the Meta CAPI tag, Meta's CAPI Gateway, or a direct integration by the client's developer.

2. Deduplication (the most common breakage)
- Meta dedupes a browser and a server event when both carry the same event_name AND the same event_id (the pixel's eventID parameter), received within 48 hours. The server event_id must equal the browser eventID exactly (case and type).
- Symptoms of broken dedup: Purchases in Ads Manager roughly double the store's orders; Events Manager shows "Browser" and "Server" counts both near the order count but the deduplicated total near double; a dedup warning in Diagnostics.
- Check: Events Manager › the pixel › the event › "Event deduplication" / overview of browser vs server; Test Events with a real test order and confirm one deduplicated event.
- Classic causes: two pixels or two integrations both sending Purchase (a hard-coded pixel in theme.liquid plus the Shopify app; GTM plus a plugin); the thank-you page firing Purchase on every reload; an event_id generated separately in browser and server (random UUIDs that don't match); order ID used on one side and a random ID on the other.
- Fix standard: one source per event per channel; event_id = the order ID (or a shared UUID passed from the page to the server) for Purchase.

3. Event Match Quality (EMQ)
- Score 0-10 per event in Events Manager. It rises with customer information parameters sent on the server event: em (email), ph (phone), fn, ln, ct, st, zp, country, external_id (all SHA-256 hashed after normalizing: lowercase, trimmed, phone in E.164 digits) plus unhashed client_ip_address, client_user_agent, fbp and fbc.
- fbc: from the _fbc cookie, or built as fb.1.<timestamp>.<fbclid> from the landing URL's fbclid when the cookie is missing. Losing fbclid in redirects (link shorteners, checkout domains, booking widgets in iframes) loses attribution.
- Target: Purchase 6+ ("good"), Lead 7+. Low EMQ on a lead business is usually phone and email not sent from the form submission.

4. Domain verification and event configuration
- Verify the client's root domain in Business Settings › Brand safety › Domains (DNS TXT or meta tag), owned by the client's Business Manager. Unverified domains limit which events can be optimized and configured.
- Aggregated Event Measurement: Meta changed how AEM works in 2025 and the old manual limit of 8 ranked events per domain is no longer something buyers set by hand. Still check that the optimization event is active, receiving volume, and on the verified domain. If an account still shows "Web event configuration" for a domain, keep Purchase (or the main lead event) at the top.

5. Diagnosing in order
1) Is the event firing at all? (Meta Pixel Helper on the page; Events Manager Test Events with a test order/lead.)
2) Is it firing once? (count per order; dedup status; duplicate pixels on the page.)
3) Are the values right? (value and currency on Purchase; value excluding tax/shipping per Kaizen's reporting standard for the client; currency matching the ad account.)
4) Is it matched? (EMQ, fbp/fbc present, customer info on server events.)
5) Is the ad set optimizing for it? (the conversion event in the ad set matches the event that fires; the pixel/dataset selected is the one receiving events.)
6) Compare to the backend: platform purchases vs store orders for the same days. Meta reports by impression/click time and modeled conversions (7-day click / 1-day view default), the store by order time: a 10-25% gap either way is normal; 2x or near 0 is broken.

6. Common Meta-specific breakages
- Purchase fires on the cart or checkout page (wrong trigger) → inflated purchases, cheap fake CPA.
- Purchase only fires for some payment methods (PayPal/Shop Pay/Klarna redirect back to a different thank-you URL).
- Subscription renewals sent as Purchase by the app (inflates ROAS); first orders only should optimize.
- Leads from a native Meta lead form don't hit the pixel at all (that's fine: they're on-Facebook leads; CRM sync via Leads Access / the CRM integration is what matters).
- Dataset/pixel mismatch: two pixels on the account, ads optimizing to the old one.
`,
  },
  {
    name: "Tracking playbook: Google Tag Manager, web and server-side",
    title: "Google Tag Manager: web and server-side containers",
    summary: "How Kaizen structures GTM web containers and server-side GTM (sGTM): the data layer, triggers, consent, the server container on a first-party subdomain, and how to debug with Preview and Tag Assistant.",
    keyPoints: [
      "One web container per site; triggers off dataLayer events, never off page URL alone for purchases",
      "sGTM on a first-party subdomain (e.g. sst.client.com) with GA4 as the transport; clients for GA4, tags for Meta CAPI, Google Ads, TikTok",
      "Preview mode + Tag Assistant to see what fires; check Consent tab",
      "Avoid duplicate gtag.js + GTM GA4 configs",
    ],
    sources: ["https://developers.google.com/tag-platform/tag-manager", "https://developers.google.com/tag-platform/tag-manager/server-side", "https://support.google.com/tagmanager/answer/6107056"],
    text: `GOOGLE TAG MANAGER: KAIZEN STANDARD

Web container
- One GTM web container per site, installed in <head> (and the noscript in <body>). No second copy of gtag.js for the same GA4 property or Google Ads tag outside GTM (double counting).
- Purchases and leads trigger on dataLayer events pushed by the site or platform (purchase, generate_lead, form_submit from the form tool's success callback), never on "Page View: URL contains /thank-you" alone (reloads and direct visits double count; some checkouts don't change URL).
- Use the GA4 ecommerce dataLayer shape: event 'purchase' with ecommerce.transaction_id, value, currency, tax, shipping, items[]. Clear the ecommerce object before each push.
- Variables: Data Layer Variables for transaction_id/value/currency; a constant for each pixel/measurement ID; user-provided data variables for enhanced conversions.
- Naming: "Platform - Event - Detail" (e.g. "Meta - Purchase - Browser"). Workspace names and version notes describe the change.

Server-side GTM (sGTM)
- What it does: the browser sends one stream (usually GA4) to a server container on a first-party subdomain (sst.client.com via a CNAME/A record); the server container's GA4 client receives it and server tags fan it out to GA4, Meta CAPI, Google Ads conversions, TikTok Events API. First-party cookies set server-side last longer in Safari; ad blockers block less.
- Hosting: Stape (fastest for most clients) or Google Cloud (App Engine/Cloud Run). Custom domain on the client's root domain, not stape.io/appspot (same-site matters for cookie life).
- Dedup with browser pixels: generate event_id once in the web container (a variable) and send it to both the browser tag and the GA4 hit; the server Meta tag reads it.
- Check the server container's Preview (it has its own) and the request/response for each outgoing tag; 200s at the vendor, and the event shown in Meta Test Events / Google Ads diagnostics.

Debugging order
1) Tag Assistant (tagassistant.google.com) with the site: which tags fire on each event, with which values.
2) Is the trigger the right one (data layer event name typo, a trigger blocked by consent)?
3) Consent tab in Preview: is the tag waiting on ad_storage/analytics_storage?
4) Published? (Changes in a workspace do nothing until published; check the live version number.)
5) Two containers on the page or a hard-coded tag duplicating the GTM one.
`,
  },
  {
    name: "Tracking playbook: GA4 events, conversions, cross-domain and consent mode v2",
    title: "GA4: events, key events, cross-domain, consent mode v2",
    summary: "GA4 setup checks Kaizen runs: recommended events, key events (conversions), cross-domain measurement for checkouts and booking tools, referral exclusions, consent mode v2, and reading GA4 against ad platforms.",
    keyPoints: [
      "Use recommended event names (purchase, generate_lead, begin_checkout) with transaction_id for dedup",
      "Mark the business outcomes as key events; import them to Google Ads only once",
      "Cross-domain: list every domain in the GA4 tag's Configure your domains; exclude payment gateways as unwanted referrals",
      "Consent mode v2: ad_storage, analytics_storage, ad_user_data, ad_personalization; required for EEA/UK traffic",
      "GA4 is last-click-ish data-driven and session-based: it will never match Meta",
    ],
    sources: ["https://support.google.com/analytics/answer/9267735", "https://support.google.com/analytics/answer/10071811", "https://developers.google.com/tag-platform/security/guides/consent", "https://support.google.com/analytics/answer/12270356"],
    text: `GA4: KAIZEN STANDARD

Events
- Use Google's recommended events where one fits: purchase (with transaction_id, value, currency, items), generate_lead (value, currency), begin_checkout, add_to_cart, sign_up, book_appointment as a custom name only when nothing recommended fits.
- GA4 dedupes purchases with the same transaction_id (for web streams); a missing transaction_id is a common source of duplicates on reloads.
- Key events (formerly "conversions"): mark the real business outcomes only. Import to Google Ads only the ones Google Ads should optimize to, and never import a GA4 purchase AND fire a Google Ads purchase tag both as Primary (double counting in Google Ads).

Cross-domain
- Checkouts and booking tools on other domains (Shopify checkout on a custom domain is same-site; a booking widget on calendly.com, a checkout on a separate payment domain, a funnel on a different root domain) need cross-domain measurement: Admin › Data streams › Configure tag settings › Configure your domains, listing every domain. Links between them then carry _gl.
- Iframes (embedded booking/scheduling widgets) don't carry _gl; send the conversion from the tool's own integration or a postMessage listener.
- Unwanted referrals: add payment gateways (paypal.com, klarna.com, stripe.com checkout pages) so returning buyers don't start a new session credited to "paypal / referral".

Consent mode v2
- Four signals: ad_storage, analytics_storage, ad_user_data, ad_personalization. Defaults set before any tag fires (consent default command or the CMP's GTM template), updated on the user's choice. Required for measurement and remarketing on EEA/UK traffic; harmless elsewhere.
- Advanced mode sends cookieless pings when denied (enables modeling); basic mode blocks tags until consent. Check in Tag Assistant's Consent view that defaults are set on page load, not after.

Reading GA4 against ad platforms
- GA4 attributes by session and its attribution model (data-driven by default, with Google's paid channels favored only within its model); it can't see view-through and loses users who decline cookies. Meta and Google Ads count by ad interaction with their own windows. Compare trends, not totals; use the backend (store/CRM) as the truth.
- "(not set)" or "Unassigned" spikes usually mean broken UTMs, lost _gl across domains, or server-sent events without session context.
`,
  },
  {
    name: "Tracking playbook: Google Ads conversion tracking, enhanced conversions, offline imports",
    title: "Google Ads conversions: tags, enhanced conversions, offline imports",
    summary: "How Kaizen sets up Google Ads conversion actions: primary vs secondary, counting, windows and values, enhanced conversions for web and leads, offline conversion imports from CRMs with GCLID, and diagnosing gaps.",
    keyPoints: [
      "One primary conversion per goal; everything else secondary (observed, not bid on)",
      "Purchases count 'every', leads count 'one'",
      "Enhanced conversions: hashed email/phone sent with the conversion; check the diagnostics tab",
      "Offline imports: capture GCLID (and gbraid/wbraid) into the CRM; upload qualified leads and sales with value",
      "Call conversions: calls from ads vs website calls via Google forwarding number",
    ],
    sources: ["https://support.google.com/google-ads/answer/1722022", "https://support.google.com/google-ads/answer/9888656", "https://support.google.com/google-ads/answer/2401634", "https://developers.google.com/google-ads/api/docs/conversions/overview"],
    text: `GOOGLE ADS CONVERSIONS: KAIZEN STANDARD

Conversion actions
- Primary actions are what Smart Bidding optimizes to and what the "Conversions" column shows; secondary actions only appear in "All conv.". One primary action per real goal; soft actions (page views, clicks on phone numbers) secondary unless the client only has those.
- Counting: purchases "Every", leads "One". Click-through window: 30 days default (up to 90 for long sales cycles); engaged-view and view-through as defaults unless the client asks.
- Values: real order value for purchases (transaction-specific); for leads a value that reflects worth (or none), never a $1 default that makes ROAS meaningless. Local Services Ads leads arrive at a default value: flag ROAS from them as not real revenue.

Tag setup
- Google tag (via GTM's Google Ads Conversion Tracking tag or gtag) with Conversion Linker on all pages (GTM). The conversion tag fires on the same event that marks a real purchase/lead, with transaction_id to dedupe.
- Don't import GA4 purchase as primary AND use the Google Ads tag as primary for the same purchase.

Enhanced conversions
- Web: the tag sends hashed email/phone/name/address captured at conversion; turn it on in the conversion action (or account-level settings) and supply user-provided data (GTM variable, automatic collection or code). Check Conversions › diagnostics: "Enhanced conversions: Recording".
- For leads: captures hashed email/phone at form submit so later offline uploads can match without GCLID.

Offline conversion imports
- Lead businesses (GoHighLevel, HubSpot, Salesforce, ServiceTitan, Jobber): store GCLID (and gbraid/wbraid for iOS) in a hidden form field and on the contact; when a lead qualifies or closes, upload the conversion with time and value (native integrations, the Google Ads API, Zapier, or scheduled CSV uploads). Uploads must arrive within the click-through window (90 days max).
- Use separate conversion actions for "Qualified lead" and "Closed sale" so the buyer can decide which to bid on.

Diagnosing
- Conversion action status: "No recent conversions", "Unverified", "Needs attention". Tag Diagnostics shows tag coverage and errors.
- Platform vs backend gap: Google counts by click date, with modeled conversions for consent/iOS loss; data-driven attribution splits credit. 10-25% differences are normal; 2x usually means a duplicate primary action.
`,
  },
  {
    name: "Tracking playbook: Shopify pixels, customer events and checkout extensibility",
    title: "Shopify: native pixels, customer events, checkout extensibility",
    summary: "How tracking works on Shopify since checkout extensibility: app pixels and custom pixels (Customer events), the sandbox they run in, what can't be done on the checkout and thank-you pages any more, and the usual Shopify breakages.",
    keyPoints: [
      "Checkout and Thank you/Order status pages run only app pixels and custom pixels (Customer events), in a sandbox",
      "checkout.liquid and 'Additional scripts' are gone: old purchase scripts there stopped firing",
      "Prefer the official channel apps (Facebook & Instagram, Google & YouTube, TikTok) at maximum data sharing",
      "Custom pixel: subscribe to checkout_completed; GTM inside a custom pixel can't see the page DOM",
      "Duplicate purchases: app + custom pixel + theme code all sending Purchase",
    ],
    sources: ["https://shopify.dev/docs/api/web-pixels-api", "https://help.shopify.com/en/manual/promoting-marketing/pixels", "https://shopify.dev/docs/apps/build/checkout", "https://help.shopify.com/en/manual/checkout-settings/order-status-page/additional-scripts"],
    text: `SHOPIFY: KAIZEN STANDARD

How it works now
- Checkout extensibility replaced checkout.liquid and the "Additional scripts" box on the order status page. Scripts there no longer run. Purchase tracking on checkout and Thank you / Order status pages happens only through:
  - App pixels: from installed apps (Facebook & Instagram by Meta, Google & YouTube, TikTok, Pinterest, Elevar, etc.), managed in Settings › Customer events.
  - Custom pixels: code added in Settings › Customer events › Add custom pixel. Runs in a sandboxed iframe (strict or lax), subscribes to standard events (page_viewed, product_viewed, product_added_to_cart, checkout_started, payment_info_submitted, checkout_completed) through analytics.subscribe.
- Customer privacy: pixels respect the store's customer privacy settings (consent) automatically when configured.

Kaizen setup
- Meta: Facebook & Instagram app connected to the client's Business Manager, pixel and catalog, data sharing "Maximum" (browser + CAPI with dedup handled by the app).
- Google: Google & YouTube app for GA4 and Google Ads conversions, or GTM loaded in a custom pixel for anything the app doesn't cover (enhanced conversions, extra platforms). In a custom pixel, GTM runs inside the sandbox: it can't read the page or DOM, only the event data passed to dataLayer from analytics.subscribe.
- TikTok: TikTok app (Events API included).
- Server-side extras (better match, longer cookies): Elevar, Littledata, Stape's Shopify app, or sGTM fed by Shopify webhooks.

Common breakages
- Old purchase code in Additional scripts or theme.liquid still "installed" but dead after the upgrade → purchases dropped to zero on a platform that relied on it.
- Purchase counted twice or three times: the official app + a custom pixel + a theme-hardcoded pixel all sending it. Keep one source per platform.
- Subscription apps (Recharge, Skio, Loop) checkouts and post-purchase upsells (ReConvert, Zipify, AfterSell) not sending the upsell revenue, or sending renewals as purchases.
- Headless/Hydrogen storefronts: the Customer events pixels still cover checkout; the storefront needs its own analytics.
- Shop Pay / accelerated checkouts: still go through checkout_completed; if a platform misses them, the integration is the browser pixel only.
`,
  },
  {
    name: "Tracking playbook: GoHighLevel tracking and webhooks",
    title: "GoHighLevel (GHL): funnels, forms, conversions and webhooks",
    summary: "How Kaizen tracks lead businesses on GoHighLevel: pixels on funnels and sites, form and calendar events, Meta CAPI and Google Ads integrations, passing fbclid/gclid and UTMs into contacts, workflows and webhooks for offline conversions.",
    keyPoints: [
      "Add tracking code at the funnel/website level (head) and per step where needed",
      "Calendars and forms embedded as iframes don't fire parent-page pixels: use GHL's conversion integrations or workflow webhooks",
      "Capture fbclid/gclid/UTMs into contact fields (hidden fields / attribution source)",
      "Use workflows: on appointment booked / opportunity won, send conversions to Meta CAPI and Google Ads",
    ],
    sources: ["https://help.gohighlevel.com/support/solutions/articles/155000001155", "https://help.gohighlevel.com/support/solutions/articles/155000002396", "https://marketplace.gohighlevel.com/docs/"],
    text: `GOHIGHLEVEL: KAIZEN STANDARD

Where tracking goes
- Funnels and websites: Settings › Tracking code (head) at the funnel/website level for the base pixels and GTM; step-level tracking code for events that only happen on that step (a thank-you step).
- Forms, surveys and calendars embedded on another site run in an iframe: the parent page's pixel can't see their submit. Options: redirect to a thank-you page on the client's domain after submit (fires the event there), GHL's own pixel/CAPI integration, or a workflow that sends the conversion server-side.

Conversions to the ad platforms
- Meta: GHL's Meta Conversions API integration (Settings › Integrations / the Facebook connection) or a workflow "Facebook Conversion API" action on triggers like Form Submitted, Appointment Booked, Opportunity Status Changed (won). Send email/phone so Meta can match; include an event_id matching the browser event if both fire.
- Google Ads: GHL's Google Ads conversion/offline integration, or upload through a workflow webhook to a middleware (Zapier/Make) that calls the Google Ads offline conversions API with the stored GCLID.

Attribution data
- GHL records first and latest attribution (UTMs, referrer, fbclid/gclid) on the contact when the visitor arrives on a GHL page with them. For forms on external sites, pass the parameters into hidden fields.
- Keep UTMs on every ad URL so GHL's attribution report and the CRM pipeline can tie revenue to campaigns.

Webhooks and workflows
- Outbound: workflow "Webhook" action posts contact/opportunity data to a URL (our server-side container or middleware) on any trigger; use it for "lead qualified" and "sale closed" offline conversions with value.
- Inbound: "Inbound Webhook" trigger lets other systems (booking tools, payment processors) create/update contacts.

Common breakages
- Leads booked in an embedded calendar never counted in Meta (iframe) → set up the CAPI workflow on Appointment Booked.
- Duplicate leads: a form submit event AND a thank-you page view both sending Lead.
- Opportunity values left at $0 → offline conversions carry no value; fix pipeline values first.
`,
  },
  {
    name: "Tracking playbook: TikTok Events API, UTMs and attribution windows",
    title: "TikTok Events API, UTMs, attribution windows",
    summary: "TikTok Pixel + Events API with deduplication, Kaizen's UTM standard, and the default attribution windows of Meta, Google Ads, TikTok and GA4 so the team can explain why numbers differ.",
    keyPoints: [
      "TikTok: Pixel + Events API, dedupe with the same event and event_id; ttclid and ttp improve matching",
      "UTMs on every ad: source, medium, campaign, content (and id parameters) with dynamic values",
      "Default windows: Meta 7-day click / 1-day view; Google Ads 30-day click; TikTok 7-day click / 1-day view; GA4 session-based data-driven",
    ],
    sources: ["https://business-api.tiktok.com/portal/docs?id=1771100865818625", "https://ads.tiktok.com/help/article/event-deduplication", "https://support.google.com/analytics/answer/10917952", "https://www.facebook.com/business/help/2198119873776795"],
    text: `TIKTOK EVENTS API
- Run the TikTok Pixel and the Events API together; dedupe with the same event name and event_id from both (or rely on the platform app, e.g. TikTok's Shopify app, which handles it).
- Matching: send hashed email and phone, external_id, plus ttclid (from the landing URL) and the _ttp cookie value on server events. Check Events Manager › Diagnostics and the event's match rate.
- Standard events: CompletePayment (purchase), SubmitForm / Contact / CompleteRegistration (leads), PlaceAnOrder, InitiateCheckout, AddToCart, ViewContent.

UTM STANDARD (every ad, every platform)
- utm_source = platform (facebook, instagram, google, tiktok), utm_medium = paid_social or cpc, utm_campaign = campaign name or id, utm_content = ad name or id, utm_term = ad set/keyword when useful.
- Meta dynamic parameters: {{campaign.name}}, {{adset.name}}, {{ad.name}}, {{campaign.id}}, {{adset.id}}, {{ad.id}}, {{placement}}, {{site_source_name}}.
- Google: auto-tagging ON (gclid) and a tracking template or final URL suffix for UTMs; ValueTrack {campaignid}, {adgroupid}, {creative}, {keyword}.
- TikTok: __CAMPAIGN_NAME__, __AID_NAME__, __CID_NAME__ macros.
- Never put UTMs on internal links (they reset the session in GA4). Redirects must keep query strings.

ATTRIBUTION WINDOWS (defaults; accounts can change them)
- Meta: 7-day click, 1-day view (1-day engaged view for video). Reported on the day of the ad impression/click, includes modeled conversions.
- Google Ads: 30-day click (purchases/leads), 3-day engaged view for video, 1-day view-through; data-driven attribution; reported on click date.
- TikTok: 7-day click, 1-day view (default for most objectives).
- GA4: data-driven across channels, 90-day lookback for acquisition key events by default (30 for others); session-based, reported on conversion date.
- Store/CRM: order or close date, no ad credit at all.
Explain gaps with this: the same order can be claimed by Meta (view), Google (click) and GA4 (last non-direct) at once; the backend counts it once.
`,
  },
  {
    name: "Tracking playbook: diagnosing common breakages",
    title: "Diagnosing tracking breakages: a field guide",
    summary: "Symptom-first troubleshooting for the breakages Kaizen sees most: double firing, missing purchases, platform vs GA4 vs backend gaps, iOS and ad-blocker loss, broken thank-you pages, sudden conversion-rate drops and zero-result spend.",
    keyPoints: [
      "Start from the backend truth (orders/leads) and compare by day",
      "Double counting: two sources for one event, reloads, missing dedup id",
      "Missing purchases: dead legacy scripts, redirect/payment-method paths, consent blocking, iframes",
      "Sudden CVR drop: check the site and checkout first, then the event, then attribution",
      "Spend with zero results: the optimization event stopped firing or the ad set optimizes to the wrong event",
    ],
    sources: ["https://www.facebook.com/business/help/1624255387706033", "https://support.google.com/google-ads/answer/7521212", "https://support.google.com/analytics/answer/9267735"],
    text: `FIELD GUIDE: SYMPTOM → CHECKS → USUAL FIX

Always first: get the backend number (store orders, CRM leads/booked calls, POS sales) for the same days, and compare by day, not by month. Note any change made around the day it broke (site redesign, theme update, checkout upgrade, new app, consent banner, domain change, new form tool).

A. Platform shows far more conversions than the backend (double firing)
Checks: count events per test order in Test Events / Tag Assistant; duplicate pixel IDs on the page (two pixels, GTM + hardcoded); dedup id missing or mismatched between browser and server; Purchase on a page that can reload (thank-you URL trigger); renewals or upsells sent as separate purchases; Google Ads: GA4 import and the Ads tag both primary.
Fix: one source per event per platform; event_id = order id; trigger on a dataLayer purchase event once; secondary for duplicates.

B. Platform shows few or no conversions while the backend has orders (missing events)
Checks: did purchases stop on a date (legacy checkout scripts after Shopify's upgrade; a theme change removed code; GTM version published without the tag)? Do some payment methods or the mobile app checkout skip the thank-you page? Is consent blocking (banner defaults to denied, tags not set up for consent mode)? Is the conversion inside an iframe (calendar, form widget)? Is the event sent to a different pixel/dataset or property than the ads use?
Fix: move the event to the platform app or server-side; add the missing path; configure consent mode; use the tool's own integration for iframes.

C. Meta vs GA4 vs backend all disagree
Expected: different windows and models (see the attribution windows doc). Healthy pattern: backend ≥ GA4 for paid social, Meta close to backend within 10-30% on purchases with CAPI. Unhealthy: Meta > backend by 1.5x+ (duplicates or view-through heavy on a low-consideration product), GA4 shows paid social near zero (UTMs stripped, cross-domain lost), Google Ads > backend (duplicate primary action).

D. iOS and ad-blocker loss
Symptom: conversions drop relative to orders after an iOS update or as Safari share grows; EMQ falling. Fix: CAPI/Events API/enhanced conversions with hashed customer data; first-party server container; keep fbclid/gclid/ttclid through redirects; don't rely on the browser pixel alone.

E. Broken thank-you / confirmation page
Symptom: purchases or leads drop to zero, orders don't. Checks: the page still exists and loads; the redirect after payment/booking points to it; the event fires once on it; the URL changed (new funnel builder, new booking tool). Fix: trigger on the platform's confirmation event rather than the URL; restore the redirect.

F. Conversion rate dropped suddenly (traffic steady)
Checks in order: is the site/checkout working (uptime, payment gateway, out-of-stock, a broken form, a slow page)? Did the event stop firing or change (see B)? Did attribution change (window, a new primary action, a switch mid-window that makes periods incomparable)? Only then blame the ads or the offer.

G. Spend with zero results for days
Checks: the ad set's optimization event (still the same, still receiving events?), the pixel/dataset selected in the ad set, the event firing on the site today, a lead form or landing page that broke, the conversion location (website vs instant form vs calls).
Fix: restore the event before touching budgets; pause if spend continues with nothing tracked and the backend confirms nothing came in.

H. Lead businesses: leads in the platform don't match the CRM
Checks: native lead forms vs website forms (different paths); CRM sync from Meta Lead Ads; spam/duplicate leads; leads counted on page view instead of submit; booked calls tracked as leads. Fix: track submit (and booking) server-side with email/phone; send qualified and closed stages back as offline conversions.

How to write the fix: numbered steps, each with where to click or what to check, what "good" looks like, and who does it (Kaizen's tracking specialist, the media buyer, or the client's developer).
`,
  },
];

/** Channels the Tracking Engineer can learn from on YouTube (Settings › AI agents › YouTube, line "tracking") */
export const TRACKING_CHANNELS = [
  { title: "MeasureSchool", handle: "MeasureSchool", why: "GTM, GA4 and server-side tagging tutorials" },
  { title: "Analytics Mania", handle: "AnalyticsMania", why: "GTM and GA4 deep dives and debugging" },
  { title: "Stape", handle: "Stape", why: "Server-side GTM, Meta CAPI and first-party tracking" },
  { title: "Loves Data", handle: "LovesData", why: "GA4 and Google Ads measurement" },
];
