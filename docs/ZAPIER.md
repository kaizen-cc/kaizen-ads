# Keeping clients in step: Zapier and Kaizen Track

Kaizen Ads hears about clients two ways. Zapier is instant. The hourly Track mirror is the safety net that catches anything changed by hand in Kaizen Track.

## 1. Zapier (instant)

Kaizen Ads uses the same secret as Kaizen Track (`ZAPIER_SECRET`, set to the same value in both Vercel projects). Send it as the `x-kaizen-secret` header, or as `Authorization: Bearer <secret>`. Every endpoint accepts JSON or form data. The form's own question titles work as field names. A repeated submission is processed only once.

| Form | Add a "Webhooks by Zapier → POST" step to | What happens |
| --- | --- | --- |
| Enrollment form (existing Zap) | `https://ads.kaizenmarketing.agency/api/zapier/enrollment` | New client created (onboarding), creative package and allotment set. An archived client enrolling again is restored with everything, as onboarding ("Welcome back"). |
| Upsell form (existing Zap) | `https://ads.kaizenmarketing.agency/api/zapier/upsell` | Creative package added or changed, allotment updated. |
| Marketing intake form (new Zap: Google Forms → new response) | `https://ads.kaizenmarketing.agency/api/zapier/intake` | Send **every** question. The answers are kept as written and read by the AI (offer, audience, voice, what to avoid, industry). The Strategist then writes the first round, built on winning ads in the same industry, and it shows on Home in the Onboarding callout. If no client matches by Client ID or business name, it waits on Home for an exec to match it. |
| Offboarding form (new Zap: Google Forms → new response) | `https://ads.kaizenmarketing.agency/api/zapier/offboarding` | Client archived (nothing deleted). Send **every** question: the Client ID or business name, the reason, and the last day if the form asks. Matching is strict: the Client ID, the exact business name, or a partial name only when one client fits; otherwise nothing is archived, Zapier shows a 422 and the execs are notified to archive the right client by hand. A last day in the future is archived on that day. The execs, customer success, the heads of the teams the client had (Meta, Google, creative: by their services, ad account, KPIs, package or the people on them) and everyone on the client are notified. |
| New Slack channel (existing Zap) | `https://ads.kaizenmarketing.agency/api/zapier/slack-channel` | Links the channel to its client. |

**The team on the enrollment and upsell forms** (media buyer, graphic designer, video editor, copywriter, customer success) becomes the client's assignments here, matched to people by name. A role the form names replaces whoever held it; a name that doesn't match exactly one active person is listed back in Zapier's response as `team_not_found`, never guessed. Assignments decide what people see: a media buyer's board, KPI board, client list and Home show only their clients (execs, leads, the copywriter and customer success see every client). The Meta KPI targets follow the media buyer.

**Packages**: a set package named plainly ("Silver", "Gold Package") works as before. Anything else ("3 Videos per Month", "Silver + 2 extra videos", "10 statics and a couple of reels") is read by the AI into monthly deliverables: the client's package becomes **Custom**, their allotment is set to exactly those counts, and what was agreed goes in the package note. Zapier's response shows how it was read (`package_read_as`).

The easiest setup is to duplicate each Zap's Kaizen Track step and change only the URL to the Kaizen Ads one. The headers and fields stay the same. Track's steps stay as they are.

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
