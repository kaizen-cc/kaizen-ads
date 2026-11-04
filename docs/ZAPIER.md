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

## 3. Loom videos into the agents' knowledge

Every Loom that reaches Kaizen Ads is read (title and transcript), sorted by the Media Buyer (ad-buying method, a client situation, both, or neither) and filed: method is distilled into the senior buyer's principles, decision rules, cases, diagnostics and voice (the Media Buyer's generated skills, and the Google auditor's for Google), a client situation goes into that client's knowledge with its durable decisions in their memory (dated), and anything else is skipped. Everything shows in **Settings → AI agents → Knowledge → Loom videos**, and a client's own Looms on their **Documents** tab.

**In Loom, once:** captions on (Loom settings, auto captions), so every video has a transcript. Videos shared to a Space (workspace only) usually still have a readable transcript; if one fails with "Loom only shows this video to people signed in", either set that video to anyone with the link, or use the browser script below.

Ways in (use as many as you like; a video is only ever processed once):

1. **Slack**: post the Loom link in the client's channel (filed to that client) or in any channel the Kaizen OS bot is in (the AI works out the client).
2. **Paste**: in Settings → AI agents → Knowledge → Loom videos, paste links (hundreds at once, one per line, a CSV export, or bare 32-character video ids). On a client's Documents tab the same box files them to that client.
3. **A shared folder**: paste a folder link (`loom.com/share/folder/…`). Every video in it (and its subfolders, when Loom shows them) is queued, and the folder is read again every day, so new recordings dropped in it come in by themselves. In Loom: open the folder, Share, turn on the public link. Loom Spaces (`loom.com/spaces/…`) can't be read from a link.
4. **Zapier** (if the Loom plan has the Loom app's "New Video" trigger), Make, or an email-parsing rule on Loom's "your video is ready" emails:

| Step | Setting |
| --- | --- |
| Trigger | Loom → New Video (or Email Parser / Gmail → new email from Loom) |
| Action | Webhooks by Zapier → POST |
| URL | `https://ads.kaizenmarketing.agency/api/loom` |
| Payload type | JSON |
| Data | `url` = the video's share URL (required). Optional: `title`, `folder`, `client` (a client's name or Kaizen ID), `recorded_at`, `transcript` |
| Headers | `x-loom-token` = the value of `LOOM_WEBHOOK_TOKEN` in Vercel |

If the tool can't set headers, add `?token=<the token>` to the URL instead. The URL can be anywhere in what's sent (a whole email body works). Sending a folder link instead saves and reads the folder. A brand-new recording whose captions aren't ready yet is tried again over the next few hours.

**Browser script (fallback for videos Loom won't show without signing in).** Open loom.com signed in, on a folder or library page, scroll until every video is listed, open the browser console and run (set the token first):

```js
const TOKEN = "paste LOOM_WEBHOOK_TOKEN here";
const ids = [...new Set([...document.querySelectorAll('a[href*="/share/"]')].map((a) => (a.href.match(/\/share\/([a-f0-9]{32})/) || [])[1]).filter(Boolean))];
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
for (const id of ids) {
  const q = await fetch("/graphql", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "apollographql-client-name": "web", "x-loom-request-source": "loom_web" }, body: JSON.stringify({ operationName: "FetchVideoTranscript", variables: { videoId: id, password: null }, query: "query FetchVideoTranscript($videoId: ID!, $password: String) { fetchVideoTranscript(videoId: $videoId, password: $password) { ... on VideoTranscriptDetails { source_url } ... on GenericError { message } } }" }) }).then((r) => r.json());
  const src = q?.data?.fetchVideoTranscript?.source_url;
  if (!src) { console.log("no transcript", id); continue; }
  const t = await fetch(src).then((r) => r.json());
  const transcript = (t.phrases || []).map((p) => `[${clock(p.ts || 0)}] ${p.value || ""}`).join("\n");
  const title = document.querySelector(`a[href*="${id}"]`)?.textContent?.trim() || "";
  const r = await fetch("https://ads.kaizenmarketing.agency/api/loom", { method: "POST", headers: { "content-type": "application/json", "x-loom-token": TOKEN }, body: JSON.stringify({ url: `https://www.loom.com/share/${id}`, title, transcript }) });
  console.log(id, r.status);
}
```

## Archiving

Execs and leads can archive a client from the client page (the Archive button by the name). Nothing is deleted: open tickets, files, copy, memory, briefings and the Brand Bible all stay inside. The client leaves the board, Home, every list, the syncs and the AI's views, and their portal is switched off. **Restore** (on the client page, or in Clients → Archived) brings it all back. A client who enrolls again comes back on their own.
