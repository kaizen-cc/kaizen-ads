// Meta's refusals in plain words, with what to do about each. Meta's own message is always kept next to it (the
// buyer may need it for support); this adds the fix.

const RULES: [RegExp, (m: RegExpMatchArray, raw: string) => { plain: string; fix: string }][] = [
  [/development mode|must be in public/i, () => ({ plain: "The Meta app Kaizen uses is in Development mode, so Meta won't let it create ad posts.", fix: "developers.facebook.com → the app → switch App Mode to Live (it needs a Privacy Policy URL, a category and an icon)." })],
  [/application does not have permission|pages_manage_ads|pages_read_engagement/i, () => ({ plain: "The system user's token can't post as this Page.", fix: "Regenerate the system user's token with pages_manage_ads, pages_read_engagement and pages_show_list, then replace META_SYSTEM_USER_TOKEN." })],
  [/page.*(permission|role|not authorized|admin)|(permission|role).*page|not.*(admin|advertiser).*page/i, (_, raw) => {
    const page = raw.match(/Page (\d{6,})/)?.[1];
    return { plain: `Kaizen can't advertise as the Page${page ? ` ${page}` : ""}.`, fix: "Business settings → Accounts → Pages → the Page → Assign people → the system user → Create ads (Advertise). A Page we don't own: Add → Request access to a Page, and its owner approves. Or run it as a partnership ad from the brand's Page." };
  }],
  [/instagram.*(not|isn't|no).*(connect|link|valid|associated)|invalid instagram|instagram_user_id|instagram account/i, () => ({ plain: "The Instagram account isn't linked to this Page (or isn't available to the ad account).", fix: "Business settings → Accounts → Instagram accounts → connect it to the Page and add it to the ad account; or run the ad on Facebook with the Page only." })],
  [/(budget).*(too low|minimum|at least)|minimum.*budget/i, (_, raw) => {
    const min = raw.match(/\$\s?([\d.,]+)/)?.[1];
    return { plain: `The budget is under Meta's minimum${min ? ` ($${min})` : ""}.`, fix: "Raise the daily budget, or put the budget on the campaign so the ad sets share it." };
  }],
  [/start.*(past|before now)|time.*in the past|end time.*(before|past)/i, () => ({ plain: "A start or end date is already in the past.", fix: "Pick dates from today on (or leave the start empty so it starts when turned on)." })],
  [/(pixel|dataset).*(not|isn't).*(associated|available|shared|access)|promoted_object|custom_event_type/i, () => ({ plain: "The pixel (dataset) or its event isn't available to this ad account.", fix: "Events Manager → the dataset → Settings → share it with the ad account (or pick the account's own dataset)." })],
  [/special ad categor/i, () => ({ plain: "This campaign needs a special ad category (housing, employment, credit, social issues or politics), or one it has doesn't fit.", fix: "Set the special ad category on the campaign; it limits targeting (no age or ZIP targeting)." })],
  [/(location|geo).*(invalid|not found|unknown)|invalid.*(city|region|key)/i, () => ({ plain: "A location in the targeting isn't one Meta knows.", fix: "Pick the place again from Meta's list (city with a radius, or a ZIP)." })],
  [/radius/i, () => ({ plain: "The location radius isn't allowed for that place.", fix: "Cities take a radius of 10 to 50 miles (17 to 80 km)." })],
  [/(image|picture).*(too small|dimension|resolution|aspect)|aspect ratio/i, () => ({ plain: "An image's size or shape isn't accepted for this placement.", fix: "Use 1080×1350 for 4:5 and 1080×1920 for 9:16." })],
  [/(text|body|message|title|headline).*(too long|exceeds|maximum length)/i, () => ({ plain: "A text option is longer than Meta allows.", fix: "Shorten it in the sheet (primary text up to 2,200 characters, headline up to 255)." })],
  [/payment|funding|billing|unsettled|disabled|closed/i, () => ({ plain: "The ad account can't run ads right now (billing or a restriction).", fix: "Business settings → Payments (or Account quality) for this ad account." })],
  [/\(#10\)|\(#200\)|\(#2\d\d\)|not authorized|permission/i, () => ({ plain: "Meta refused Kaizen's access to this ad account.", fix: "Business settings → Accounts → Ad accounts → this account → Assign people → the system user → Manage campaigns." })],
  [/\(#190\)|access token|session has expired/i, () => ({ plain: "Kaizen's Meta token has expired or was revoked.", fix: "Generate a new system user token in Business settings and replace META_SYSTEM_USER_TOKEN." })],
  [/media.*(not found|does not exist)|source_instagram_media_id|object_story_id/i, () => ({ plain: "The existing post can't be used as an ad (deleted, private, or on an account the ad account can't use).", fix: "Check the post is live and its Instagram account or Page is connected to the ad account; a collab or shared post may need the owner to allow ads (Partnership ad code)." })],
  [/video.*(processing|not ready|encod)/i, () => ({ plain: "Meta is still processing the video.", fix: "Retry this line in a few minutes." })],
  [/enroll_status|creative_features_spec|degrees_of_freedom/i, () => ({ plain: "Meta didn't accept one of the Advantage+ creative switches on this API version.", fix: "Retry: Kaizen drops the switch Meta doesn't know." })],
];

/** Meta's error as plain words and the fix (raw kept for support) */
export function explainMetaError(raw: string): { plain: string; fix: string } {
  for (const [re, f] of RULES) {
    const m = raw.match(re);
    if (m) return f(m, raw);
  }
  const user = raw.split(" · ").slice(1).join(" · ").trim();
  return { plain: user || raw.replace(/^Meta \([^)]*\):\s*/, ""), fix: "Change what Meta names above and check this line again." };
}
