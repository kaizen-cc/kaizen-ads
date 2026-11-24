# Shopify in Kaizen OS: setup

Kaizen OS reads each client's Shopify store (read only) so real store revenue and orders show up across the OS:
- the client page's **Store revenue** card
- the KPI card
- reports: Store revenue, Store orders and MER tiles, plus custom-report before/after
- the assistant and agents: `store_revenue`, `store_before_after`, `store_connections`, `connect_shopify`, `set_kaizen_start`
- case studies

## Route 1 (primary, works today): a custom app made through our collaborator access

Kaizen is a Partner collaborator on clients' stores. For each store, the team does this:

1. **Collaborator permissions.** The request needs **Manage and install apps and channels** and **Enable development**
   (Shopify's "App development" section; custom app development is off by default). New requests sent from the portal
   guide now tell the team to include both, and tell the client to keep them ticked. For stores we're already on, ask the
   client to add them under Settings › Users › our collaborator account.
2. Open the store from Shopify Partners › Stores, then go to **Settings › Apps and sales channels › Develop apps › Create an
   app**, named `Kaizen OS`.
3. Under **Configure Admin API scopes**, tick `read_orders`, `read_all_orders`, `read_products` and `read_customers`. Then
   Save › **Install app** › reveal the **Admin API access token** (`shpat_…`, shown once).
4. In Kaizen OS, open the client page › Whole business › **Store revenue**, enter the store address, paste the token, then
   **Check and connect**. The token is checked right away, then encrypted with `TOKEN_ENCRYPTION_KEY`.

Custom apps need no Shopify review, and `read_all_orders` and customer data are always available to them.

**Caveat (Shopify, Nov 2026):** Shopify now says admin-created custom apps "can't be created anymore, though existing apps
keep working". Existing tokens work, but a store may no longer offer *Create an app* to anyone, and Shopify's docs don't
confirm whether it does. If a store won't let us make one, use route 2.

## Route 2 (fallback, works today): the store owner's own app

The store owner (not a collaborator: Shopify's Dev Dashboard needs organization access) does this:
1. Go to dev.shopify.com › Apps › Create app, named `Kaizen OS`, with the same four scopes, and install it on their store.
2. Send us its **client ID and client secret**.

On the Store revenue card, choose **The store owner makes it**. Kaizen OS gets 24-hour tokens from Shopify's
client-credentials grant as needed. That grant only works because the app and the store are in the same organization.

## Route 3 (secondary, needs owner setup and Shopify review): the Kaizen OS app (OAuth)

This route is for stores where we have no collaborator access. The client can also use it from their portal guide
(**Connect Shopify sales**). The code is built and dormant until the keys are set.

1. Go to https://dev.shopify.com/dashboard/ in Kaizen's Partner organization › Apps › **Create app** › Start from Dev
   Dashboard, and name it `Kaizen OS`.
2. In **Versions**, set:
   - App URL: `https://app.kaizenmarketing.agency/api/shopify/install`
   - Not embedded
   - Redirect URL: `https://app.kaizenmarketing.agency/api/shopify/callback` (also add the `ads.` one while
     `NEXT_PUBLIC_SITE_URL` points there)
   - Scopes: `read_orders,read_all_orders,read_products,read_customers`
   - Webhooks API version: `2026-07`
   - Webhooks: `app/uninstalled` plus the compliance topics `customers/data_request`, `customers/redact` and `shop/redact`,
     all to `https://app.kaizenmarketing.agency/api/shopify/webhooks`

   Then **Release**.
3. Under Settings › **Access requests**, make two requests:
   - **Read all orders** › Request access. Without it you only get 60 days, so no "before Kaizen".
   - **Protected customer data** › Manage › select *Customer data* (Level 1: no names, emails, addresses or phones; we read
     a customer's id, first-order index and order count to tell new buyers from returning ones). Give the reasons
     (analytics/reporting for the merchant) and fill in **Data protection details**. Shopify's Level 1 checklist: minimum
     data, tell merchants, use only for stated purposes, consent, opt-outs, privacy agreements with merchants, retention
     periods, and encryption at rest and in transit. We store daily totals only, never customer records, and tokens are
     encrypted.
4. Choose **Public distribution, unlisted**. Custom distribution only reaches one store or one Plus organization. Shopify
   reviews the app and charges a one-time registration fee, and the distribution method can't be changed later.
5. In Vercel (Production), set `SHOPIFY_API_KEY` (client ID) and `SHOPIFY_API_SECRET`, optionally `SHOPIFY_REDIRECT_URI`,
   then redeploy. New apps get expiring tokens (1 hour, with a 90-day refresh); Kaizen OS refreshes them itself.

## Who to connect

Settings › Connections › **Client stores** lists:
- connected stores, with how far back their history goes
- clients that sell on Shopify but aren't connected, found from their website, their Klaviyo's order source and their
  onboarding answers (each client is checked weekly)

On each store card, set **Started with Kaizen**. That date is where before-and-after splits; if it's blank, the first ad
spend we have is used.

## How syncing works

- The `shopify` cron runs every 10 minutes. It reads each new store's history first, a month at a time, newest first, back
  to the first order, paced by Shopify's cost meter. A store too big for one run gets shorter windows.
- After that, each store is refreshed hourly: today, yesterday, and any day whose orders changed (refunds, cancellations).
- Only days whose numbers changed are written to `shopify_daily`, following `src/lib/unchanged.ts`. The last 120 days are
  also mirrored into `client_business_daily`.
- **Store revenue** is Shopify's total sales less refunds; test and cancelled orders are left out. A refund counts on the
  order's day.
- **MER** is store revenue divided by ad spend on Meta, Google and TikTok, from the ad accounts on the KPI board.
