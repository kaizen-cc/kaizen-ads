// One-time: add the Kaizen OS Slack bot to private channels you're in (bots can't join private channels themselves).
//
//   SLACK_USER_TOKEN=xoxp-… SLACK_BOT_TOKEN=xoxb-… node scripts/slack-invite-bot.mjs            lists what it would do
//   SLACK_USER_TOKEN=xoxp-… SLACK_BOT_TOKEN=xoxb-… node scripts/slack-invite-bot.mjs --go       does it
//   … --clients               only client channels (names ending in the client's ID, e.g. internal-crust-pizza-212)
//   … --match=crust,nectr     only channels whose name contains one of these
//
// The user token needs groups:read and groups:write (User Token Scopes on the Kaizen OS app).
// Public channels don't need this; the 12pm/6pm sync joins those itself.

const user = process.env.SLACK_USER_TOKEN;
const bot = process.env.SLACK_BOT_TOKEN;
if (!user?.startsWith("xoxp-") || !bot?.startsWith("xoxb-")) {
  console.error("Set SLACK_USER_TOKEN (xoxp-…) and SLACK_BOT_TOKEN (xoxb-…) first.");
  process.exit(1);
}
const go = process.argv.includes("--go");
const match = (process.argv.find((a) => a.startsWith("--match="))?.slice(8) ?? "")
  .split(",")
  .map((m) => m.trim().toLowerCase())
  .filter(Boolean);

async function slack(token, method, params) {
  for (;;) {
    const res = await fetch(`https://slack.com/api/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 5) * 1000));
      continue;
    }
    const body = await res.json();
    if (!body.ok) throw new Error(`${method}: ${body.error}`);
    return body;
  }
}

const { user_id: botUser } = await slack(bot, "auth.test", {});
const channels = [];
let cursor = "";
do {
  const page = await slack(user, "users.conversations", { types: "private_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}) });
  channels.push(...page.channels);
  cursor = page.response_metadata?.next_cursor ?? "";
} while (cursor);

const clientsOnly = process.argv.includes("--clients");
const targets = channels
  .filter((c) => !clientsOnly || /-\d{2,6}$/.test(c.name))
  .filter((c) => !match.length || match.some((m) => c.name.toLowerCase().includes(m)));
console.log(`${targets.length} private channel(s) you're in${match.length ? " matching " + match.join(", ") : ""}:`);

let added = 0;
for (const c of targets) {
  const { members } = await slack(user, "conversations.members", { channel: c.id, limit: "1000" });
  if (members.includes(botUser)) {
    console.log(`  #${c.name}  already has the bot`);
    continue;
  }
  if (!go) {
    console.log(`  #${c.name}  would add the bot`);
    continue;
  }
  try {
    await slack(user, "conversations.invite", { channel: c.id, users: botUser });
    console.log(`  #${c.name}  added`);
    added++;
  } catch (e) {
    console.log(`  #${c.name}  couldn't add: ${e.message}`);
  }
}
console.log(go ? `\nAdded the bot to ${added} channel(s).` : "\nNothing changed. Run again with --go to add the bot.");
