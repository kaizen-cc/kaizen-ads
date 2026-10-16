# Keeping clients in step: Zapier and Kaizen Track

Kaizen Ads hears about clients two ways. Zapier is instant. The hourly Track mirror is the safety net that catches anything changed by hand in Kaizen Track.

## 1. Zapier (instant)

Kaizen Ads has its own secret (`ZAPIER_SECRET` in the kaizen-ads Vercel project; it doesn't need to match Track's). Send it on every Kaizen Ads step as the `x-kaizen-secret` header, or as `Authorization: Bearer <secret>`. Every endpoint accepts JSON or form data. The form's own question titles work as field names. A repeated submission is processed only once.

| Form | Add a "Webhooks by Zapier → POST" step to | What happens |
| --- | --- | --- |
| Enrollment form (existing Zap) | `https://ads.kaizenmarketing.agency/api/zapier/enrollment` | New client created (onboarding), creative package and allotment set. An archived client enrolling again is restored with everything, as onboarding ("Welcome back"). |
| Upsell form (existing Zap) | `https://ads.kaizenmarketing.agency/api/zapier/upsell` | Creative package added or changed, allotment updated. |
| Marketing intake form (new Zap: Google Forms → new response) | `https://ads.kaizenmarketing.agency/api/zapier/intake` | Send **every** question. The answers are kept as written and read by the AI (offer, audience, voice, what to avoid, industry). The Strategist then writes the first round, built on winning ads in the same industry, and it shows on Home in the Onboarding callout. If no client matches by Client ID or business name, it waits on Home for an exec to match it. |
| Offboarding (if there's a form; optional) | `https://ads.kaizenmarketing.agency/api/zapier/offboarding` | Client archived (nothing deleted). Send the business name or Client ID, plus a reason if there is one. |
| New Slack channel (existing Zap) | `https://ads.kaizenmarketing.agency/api/zapier/slack-channel` | Links the channel to its client. |

The easiest setup is to duplicate each Zap's Kaizen Track step, change the URL to the Kaizen Ads one, and set the header to Kaizen Ads' own secret. Track's steps stay as they are.

## 2. Kaizen Track mirror (hourly)

Once `TRACK_SUPABASE_URL` and `TRACK_SUPABASE_SECRET_KEY` (Track's project URL and its secret key) are set in Vercel, every hour:

- A client **archived in Track** is archived here.
- A client **made active again in Track** is restored here, as onboarding.
- A **new client in Track** is added here.
- A creative package **added or changed in Track** is applied here.
- A package **removed in Track** is reported, not applied, so a slip in Track never switches off a client's creative here.

To run it by hand, open `https://ads.kaizenmarketing.agency/api/cron/context?step=clients` while signed in as an exec.

## Archiving

Execs and leads can archive a client from the client page (the Archive button by the name). Nothing is deleted: open tickets, files, copy, memory, briefings and the Brand Bible all stay inside. The client leaves the board, Home, every list, the syncs and the AI's views, and their portal is switched off. **Restore** (on the client page, or in Clients → Archived) brings it all back. A client who enrolls again comes back on their own.
