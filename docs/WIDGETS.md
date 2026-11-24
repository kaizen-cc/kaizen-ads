# Overview widgets

Every role's Overview keeps its default layout: the "Your day" hero and at most six blocks. On top of that, each person
can add pre-built widgets from a gallery ("Add widget", like Stripe's dashboard), then remove them or change their
order. Widgets are a personal choice: they never replace the blocks, and nobody gets one they didn't add.

The registry lives in `src/lib/widgets-core.ts` (ids, who can add each one, what it reads), the data in
`src/lib/widgets.ts`, and the gallery and tiles in `src/app/(team)/pipeline/views/widgets.tsx`. Each person's choice
is `profiles.overview_widgets` (an ordered list of widget ids), and the gallery's open state is in the address
(`?widgets=1`).

**Status:** "Built" is in the first set. "Next" is listed in the gallery as coming soon, with the data source already
known.

## Execs and the CEO: finance and sales

| Widget | What it shows | Data source | Status |
| --- | --- | --- | --- |
| Revenue by line (MRR) | Monthly recurring revenue per line (Meta, Google, TikTok, email, social, creative, web) and the total | `clients.billed_services` (the last billed amount per service, from billing sync), live clients only | Built |
| Retainer projection | MRR carried to month end and quarter end, minus clients at risk of leaving | `clients.billed_services` × months left; at-risk clients from the retention model (`atRiskNow`) | Built |
| Sales pipeline | Prospects by stage (new, researched, contacted, meeting, proposal, won, lost) and won this month | `prospects` (the new Sales section), `prospects.won_at` | Built |
| Clients and churn risk | Live clients, how many at risk and who | `clients` (live, not internal) and the retention model | Built |
| Spend under management | Ad spend in the last 30 days across every account, and by platform | `kpi_snapshots.windows.d30.spend` | Built |
| Team load | Open items per teammate: tasks asked of them, items stuck 48 hours, escalations | `agent_asks` (open), `ladder_nudges` (open or sent) | Built |
| Gross margin by line | Revenue minus team cost per line | Needs team cost per role (not in Kaizen OS yet) | Next |
| Cash in this month | Invoices paid vs due | Needs the billing system's paid invoices (billing sync has amounts, not payments) | Next |
| New vs lost MRR | MRR added and lost this month | `clients.billed_services` history (needs a monthly snapshot) | Next |

## Execs and leads: clients and performance

| Widget | What it shows | Data source | Status |
| --- | --- | --- | --- |
| My clients' targets | Each of my clients on target, close or off, worst first | `kpi_snapshots.status` for clients in `client_assignments` (execs: their focus lines) | Built |
| Client card (pick a client) | One client's spend, results, cost per result and trend, with its page one tap away | `kpi_snapshots` for the chosen client | Next (needs per-widget settings) |
| KPI trend (pick a KPI) | ROAS, CPA or CPL over 30 and 90 days for chosen clients | `kpi_snapshots.windows` | Next |
| Creative output | Briefs made, approved and delivered this week by the team | `briefs`, board tickets | Next |
| Email results | Revenue and open rate from email this month | `klaviyo_campaign_metrics`, `klaviyo_flow_metrics` | Next |

## Every role

| Widget | What it shows | Data source | Status |
| --- | --- | --- | --- |
| My clients' targets | As above, for the clients I'm on | `kpi_snapshots`, `client_assignments` | Built |
| My load | What's asked of me, by whom, and what's overdue | `agent_asks` (owner = me) | Built |
| Done this week | What I closed this week | `daily_items` (done) | Next |

## Rules

- The six blocks are the default and stay. Widgets show under them, in the person's own order.
- Finance and sales widgets are for execs only. A widget someone can't add never shows, even if it's in their list.
- Every number has its source above; a widget whose source is empty says so plainly instead of showing zero.
- Scores stay internal (social and email scores never in client reports); widgets are internal too.
