import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aiEnabled } from "@/lib/ai";
import { checkGoogle } from "./google";
import { linkAdAccounts, metaConfigured } from "./meta";
import { checkSlack } from "./slack";

type Check = { ok: boolean; detail: string };

const run = async (fn: () => Promise<string>): Promise<Check> => {
  try {
    return { ok: true, detail: await fn() };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
};

/** Tests every connection the briefings need, without reading or saving any client data. */
export async function checkSetup(admin: SupabaseClient) {
  const { count: withContacts } = await admin
    .from("contact_clients")
    .select("client_id, clients!inner(creative_package)", { count: "exact", head: true })
    .eq("clients.creative_package", true);
  const google = await checkGoogle();
  return {
    cronSecret: { ok: Boolean(process.env.CRON_SECRET), detail: process.env.CRON_SECRET ? "Set" : "CRON_SECRET is missing, so the 12pm/6pm runs won't start" },
    claude: { ok: aiEnabled(), detail: aiEnabled() ? "Key set" : "ANTHROPIC_API_KEY is missing" },
    slack: await run(checkSlack),
    meta: metaConfigured()
      ? await run(async () => {
          const r = await linkAdAccounts(admin);
          return `Sees ${r.accounts.length} ad accounts${r.linked.length ? `; just linked ${r.linked.join(", ")}` : ""}. Creative clients without an ad account: ${r.creativeClientsWithoutAccount.length ? r.creativeClientsWithoutAccount.join(", ") : "none"}.`;
        })
      : { ok: false, detail: "META_SYSTEM_USER_TOKEN is missing" },
    googleAds: await (await import("@/lib/context/google-ads")).checkGoogleAds(),
    drive: google.drive,
    mailboxes: google.mailboxes,
    gmail: google.gmail,
    clientContacts: { ok: Boolean(withContacts), detail: `${withContacts ?? 0} contact links on creative-package clients (email is matched to clients through these)` },
  };
}
