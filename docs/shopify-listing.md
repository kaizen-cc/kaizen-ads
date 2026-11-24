# Kaizen OS on Shopify: listing and submission (unlisted public app)

Copy-paste text for each field the Partner Dashboard asks for when you submit **Kaizen OS** for review as an **unlisted**
public app. Shopify's form labels change from time to time, so match each block by meaning. Character limits noted
here are Shopify's usual ones; the form shows the live count.

---

## Submit, in this order (Partner Dashboard / Dev Dashboard, Kaizen Marketing Partner organization)

1. **App setup (already in the draft app).** In Versions, check that the release has:
   - App URL `https://app.kaizenmarketing.agency/api/shopify/install`
   - redirect `https://app.kaizenmarketing.agency/api/shopify/callback`
   - scopes `read_orders,read_all_orders,read_customers`
   - not embedded
   - webhooks API version `2026-07`
   - `app/uninstalled`, `customers/data_request`, `customers/redact` and `shop/redact`, all to
     `https://app.kaizenmarketing.agency/api/shopify/webhooks`

   If anything changed, release a new version.
2. **Vercel.** Replace `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` with this app's Client ID and secret (Production), then
   redeploy. Without this step, the reviewer's install fails.
3. **Aldecoa.** Its own pair (the app made inside Aldecoa's organization) goes on Aldecoa's client page instead: Store revenue
   › *The store owner makes it* › client ID + client secret › Check and connect. Do this before step 2's redeploy, so
   nothing is lost.
4. **Access requests** (app › Settings › Access requests):
   - **Read all orders** › Request access, using the justification below.
   - **Protected customer data** › Manage › *Customer data* (Level 1 only: leave name, email, phone and address off),
     using the reasons and "Data protection details" answers below. Save.
5. **Distribution** › **Public distribution**. This can't be changed later. Pay the one-time registration fee if asked.
6. **App listing** › fill in every field below. Set **Listing visibility: Unlisted**. Upload the icon and screenshots.
7. **Testing instructions** (in the submission form): paste the reviewer instructions below.
8. **Pre-launch checks**: run Shopify's automated checks on the submission page and fix anything they flag.
9. **Submit for review.** Shopify emails the result. Once approved, install links work on any store, and the app is reachable
   only by its link (unlisted).

---

## Listing fields

**App name** (30 characters or fewer)
```
Kaizen OS
```

**App introduction / tagline** (100 characters or fewer)
```
Your real Shopify sales next to your ads, so Kaizen Marketing grows your store by revenue, not clicks.
```

**App details / description** (500 characters or fewer)
```
Kaizen OS connects your store to Kaizen Marketing, your advertising agency. It reads your orders (read only) and turns them into daily totals: store revenue, orders, average order value, and new vs returning customers. Kaizen puts them beside your Meta, Google and TikTok spend to show MER and true growth, before and after you started with us. Your results appear in your reports and client portal. Nothing in your store changes, and no customer names or emails are stored.
```

**Key benefits / feature list** (3 to 5, about 80 characters each)
```
Real store revenue and orders, read only, refreshed every hour
MER: your store revenue against every ad dollar on Meta, Google and TikTok
Before-and-after growth since you started working with Kaizen
New vs returning customers and where buyers came from
Daily totals only: no customer names, emails or addresses stored
```

**Pricing:** Free. Choose *Free to install* with no plans; the service is part of the Kaizen Marketing engagement.

**Category:** Store management › Analytics (or Marketing › Analytics, whichever the form offers).

**Languages:** English.

**Support email:** `santi@kaizenmarketing.agency`

**Support / website URL:** `https://kaizenmarketing.agency`

**Privacy policy URL:** `https://app.kaizenmarketing.agency/privacy#shopify`

**FAQ** (optional)
```
Q: Can Kaizen change anything in my store?
A: No. The app only has read access to orders and each order's customer ID and order count.

Q: What happens if I uninstall?
A: The access token is deleted immediately, and everything read from your store is deleted when Shopify sends its deletion request 48 hours later.
```

### App icon
- Shopify wants **1200 × 1200 px**, PNG or JPEG, with no text and no rounded corners (Shopify rounds them).
- `/public` has no icon at that size: `kaizen-mark.png` is 512 × 512 and `kaizen-logo.png` is a 500 × 140 wordmark.
- A 1200 × 1200 icon is ready at **`docs/assets/kaizen-os-shopify-icon-1200.png`**: the red mark centered on white,
  upscaled from the 512 px mark. If the brand's vector original is handy, re-export from it for a sharper edge.

### Screenshots (needed)
Shopify asks for at least 3 desktop screenshots at **1600 × 900 px** (PNG or JPEG), with no browser chrome and no
personal data. Use a demo or connected client with nothing sensitive showing:
1. Client page › **Store revenue** card: 30-day revenue, orders, AOV, new customers and MER, with the 90-day chart.
2. **Before and after Kaizen**: the month-by-month bars and the before → after line.
3. The **KPI card** Numbers tab with the "Their store" strip, or a report showing the Store revenue and MER tiles.
4. Optional: the Shopify-side "Kaizen OS is connected" page that a merchant sees after installing.

Blur or crop client names if the store isn't a demo.

---

## Reviewer testing instructions (paste into the submission)
```
Kaizen OS is the internal platform of Kaizen Marketing, an advertising agency. Merchants install it so the agency can read their store's sales (read only) and report them next to their ad spend. It has no merchant-facing settings.

To test:
1. Install the app on your development store from the install link. The app starts OAuth immediately and asks for read-only access (orders, all orders, customers).
2. After approving, you land on a "Kaizen OS is connected" page. The store is now connected; within 10 minutes Kaizen OS reads the store's order history (back to the first order) and keeps daily totals, refreshed hourly.
3. Opening the app again from Apps shows the same connected status.
4. Uninstall: the app/uninstalled webhook deletes the access token immediately; shop/redact (48 hours later) deletes all data read from the store. customers/data_request and customers/redact are acknowledged (we store no per-customer data).

The reports themselves live in Kaizen OS (app.kaizenmarketing.agency), which requires an agency or client login. Screenshots of those screens are in the listing. If you'd like to see your test store's numbers inside Kaizen OS, email santi@kaizenmarketing.agency and we'll send a temporary reviewer login.
```
Put some test orders in the development store first, so the history read has something to read.

---

## Access request answers

### Read all orders: justification
```
Kaizen Marketing runs each merchant's advertising. We compare the merchant's store revenue before and after they started working with us (often 1 to 3 years back) and calculate MER (store revenue over ad spend) across their history. Without orders older than 60 days, the "before" side can't be measured. Access is read only, and we store daily totals, not orders.
```

### Protected customer data, Level 1 (customer data only; no name, email, phone or address)
**Why do you need this data?** Select *App functionality* and *Analytics*, then:
```
To count new versus returning customers for the merchant's own reports, we read each order's customer ID, the customer's order count and Shopify's customer order index. These are used only to compute daily totals, which are all we store (for example, "30 new customers on March 3"). No customer-level record is kept.
```

**Data protection details.** The answers below match what the app actually does:
- **Process the minimum data needed:** Yes. Only the customer ID, created date, order count and order index are read; names, emails, phones and addresses are never requested.
- **Tell merchants what data you process and why:** Yes, in the privacy policy (`/privacy#shopify`) and the listing.
- **Limit use to the stated purposes:** Yes. The data is used only for the merchant's own reporting; never for other merchants, ads or profiling.
- **Respect consent and opt-out decisions:** Yes. We store no individual customer data, so there's nothing per customer to keep or share.
- **No selling or sharing:** Yes. We don't sell or share data; it's processed only by our hosting providers.
- **No automated decisions with legal or similar effects:** None are made.
- **Privacy and data protection agreements with merchants:** Yes, through our client agreement and the privacy policy.
- **Retention periods:** Daily totals are kept while the merchant is a client. The token is deleted on uninstall, and all store data on `shop/redact` (48 hours after uninstall), or sooner on request.
- **Encryption at rest and in transit:** Yes. Tokens are AES-256-GCM encrypted; the database (Supabase) encrypts data at rest; all traffic uses TLS.
- **Restrict staff access / logging:** Only signed-in Kaizen team members (and the merchant's own invited contacts) can read it, enforced by database row-level security; tokens are never shown back to anyone.

---

## Self-review against the App Store requirements (Nov 24, 2026)

**Status values:** **Pass** = Kaizen OS meets it; **Fixed** = changed in code; **Owner** = the owner has to do something; **Risk** = review may push back.

| Requirement | Status | Note |
| --- | --- | --- |
| 2.3.2 Authenticate immediately on install | Pass | Shopify-managed install (`use_legacy_install_flow = false`). Embedded: the session token is exchanged for the store's token on first load. Not embedded: the App URL starts OAuth for an unknown store. |
| 2.3.3 Redirect to the app UI after install | Pass | Install lands on the app page: what's connected, and the store's last 30 days once read. |
| 2.3.4 Reinstall works | Pass | Uninstall deletes the token. A reinstall exchanges or OAuths again and relinks to the client the store had before. |
| 2.3.1 No manual myshopify.com entry in Shopify's install flow | Pass | Only Kaizen's own team page asks for a store address; Shopify's flow never does. |
| No merchant login or account before use | Pass | The app page needs no Kaizen login. |
| Webhook HMAC → 401; compliance webhooks → 2xx | Pass | `/api/shopify/webhooks`: bad signature 401, every topic 200. `shop/redact` erases everything read from the store. |
| 3.1.1 TLS | Pass | Vercel HTTPS. |
| 3.1.2 Expiring offline tokens | Pass | `expiring=1` on the code and token exchanges; refreshed automatically. |
| 2.2.4 GraphQL Admin API only | Pass | Every call is GraphQL (`2026-07`). |
| 3.2 Only the scopes the app uses | Fixed + **Owner** | Kaizen OS now asks for `read_orders,read_all_orders,read_customers`. In `kaizen-shopify-app/shopify.app.toml`, set `scopes = "read_all_orders,read_customers,read_orders"` (drop `read_products` and `read_analytics`), then `shopify app deploy`. |
| 2.2 / 2.2.2 Embedded admin experience | Fixed + **Owner** | The App URL now serves an App Bridge page that the store's admin may frame (CSP `frame-ancestors`), with the session-token check and token exchange. In the toml, set `embedded = true`, then deploy. The page then opens inside Shopify admin. |
| 2.1.3 Works through a UI | Pass | The page in Shopify admin shows connection status and the store's 30-day revenue, orders and history read. |
| Pricing | **Owner** | Free app: choose **Free to install**. If Shopify App Pricing is on with a $0 plan, switch the app to free / manual pricing. The plan-selection redirect only applies to apps that charge, and Kaizen OS has no billing code. |
| Protected customer data (Level 1) | **Owner** | Submit the request with the answers above. |
| 4.3.3 No stats or claims in the listing | Pass | Screenshots regenerated without comparisons, and the listing copy has none. |
| 4.5.3 Demo screencast (required) | **Owner** | Record about 1 minute: install on the dev store › approve › the app page in admin shows connected › the store's numbers. English. |
| 4.5.4 / 4.5.5 Test credentials, no 2FA | **Owner** | The app page needs no login. If reviewers ask to see Kaizen OS itself, give them a client-portal test login with no 2FA. |
| 4.5.6 Emergency developer contact | **Owner** | Fill it in (name, email, phone). |
| 1.1.14 Apps connecting merchants to agencies | **Risk** | Kaizen OS reports a merchant's own sales to the agency they already hired; it doesn't match merchants with agencies. If review raises it, say so, or fall back to custom distribution / per-store apps (route 1 and route 2 on the client page work without the public app). |

## Watch-outs before submitting
- **Embedded apps:** the app page now works embedded (App Bridge, session token, token exchange). Set `embedded = true`
  in the toml before submitting.
- **Reviewer access:** the reviewer instructions offer a temporary login. Have a client-portal login ready, linked to a
  demo client, before you submit.
- **Install from Shopify's side:** a store that installs from the link without starting in Kaizen OS is linked
  automatically when its address matches a client (from their website or onboarding answers). Otherwise it shows under
  Settings › Connections › Client stores › *Installed, waiting to be linked*, and the client page has **Link to this client**.
