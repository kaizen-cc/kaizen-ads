import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SUPPORT_SENDER, supportCase, supportNeedsReply } from "@/lib/ops-items-core";

// Ad-platform support emails that need a reply (Nov 27 2026: Meta Support asked for more information on a rejected-ads
// case in an exec's inbox; the OS reads only mail to and from client contacts, so it never saw it). Each mailbox's
// support mail from the last three days is read; one that asks for something back becomes an item for that mailbox's
// owner (their own inbox, so not routed), with the case number, the client when the email names its ad account or its
// name, and the link. Once per email.

type Admin = SupabaseClient;

export async function supportEmailItems(admin: Admin) {
  const { googleConfigured, gmailMailboxes, gmailToken, google, plainText, withoutQuotes } = await import("@/lib/context/google");
  if (!googleConfigured()) return { skipped: "Google isn't connected" };
  const [{ data: people }, { data: clients }] = await Promise.all([
    admin.from("profiles").select("id, email").eq("is_active", true),
    admin.from("clients").select("id, name, meta_ad_account_id").is("archived_at", null).limit(1000),
  ]);
  const ownerOf = new Map((people ?? []).map((p) => [String(p.email ?? "").toLowerCase(), p.id as string]));
  const { gmailLink } = await import("@/lib/email-filters");
  let made = 0;
  for (const mailbox of await gmailMailboxes().catch(() => [] as string[])) {
    const owner = ownerOf.get(mailbox.toLowerCase());
    if (!owner) continue;
    try {
      const token = await gmailToken(mailbox);
      const list = await google<{ messages?: { id: string }[] }>(token, "https://gmail.googleapis.com/gmail/v1/users/me/messages", {
        q: "from:(support.facebook.com OR fb.com OR facebookmail.com OR business.facebook.com OR ads-support@google.com OR noreply-ads-support@google.com OR tiktok.com) newer_than:3d -category:promotions",
        maxResults: "25",
      });
      for (const { id } of list.messages ?? []) {
        const m = await google<{ id: string; threadId: string; internalDate: string; snippet?: string; payload: { headers: { name: string; value: string }[] } & Parameters<typeof plainText>[0] }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`, { format: "full" });
        const header = (n: string) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value ?? "";
        if (!SUPPORT_SENDER.test(header("from"))) continue;
        const subject = header("subject");
        const body = withoutQuotes(plainText(m.payload) ?? m.snippet ?? "").replace(/\s+/g, " ").slice(0, 3000);
        if (!supportNeedsReply(subject, body)) continue;
        const ref = `support:${header("message-id") || `${mailbox}:${m.id}`}`;
        const { data: have } = await admin.from("agent_asks").select("id").eq("source_ref", ref).limit(1).maybeSingle();
        if (have) continue;
        const text = `${subject} ${body}`;
        const client = (clients ?? []).find((c) => (c.meta_ad_account_id && text.includes(String(c.meta_ad_account_id).replace(/^act_/, ""))) || (String(c.name).length >= 4 && text.toLowerCase().includes(String(c.name).toLowerCase())));
        const kase = supportCase(text);
        const platform = /google/i.test(header("from")) ? "Google Ads" : /tiktok/i.test(header("from")) ? "TikTok" : "Meta";
        const { error } = await admin.from("agent_asks").insert({
          kind: "task",
          owner_id: owner,
          asked_by: owner,
          client_id: client?.id ?? null,
          title: `Reply to ${platform} Support${kase ? ` case ${kase}` : ""}: ${subject.replace(/\s+/g, " ").slice(0, 120)}`.slice(0, 300),
          detail: `${platform} Support is waiting on a reply${client ? ` (${client.name})` : ""}: "${body.slice(0, 500)}"\n${gmailLink(mailbox, m.threadId)}\n(Created by Kaizen OS from your inbox.)`,
          due_on: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
          source_ref: ref,
          facts: { links: [{ label: "Gmail thread", url: gmailLink(mailbox, m.threadId) }] },
        });
        if (!error) made++;
      }
    } catch {
      // A mailbox without Gmail access is skipped
    }
  }
  return { made };
}
