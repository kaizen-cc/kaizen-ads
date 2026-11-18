import "server-only";
import { clientNamed } from "@/lib/client-named";
import type { Staff } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { str, type AiTool } from "./types";

// The account watch, for the assistant and every agent (registered in src/lib/kaizen-ai/extensions.ts):
//   account_watch            what's open: billed but idle, neglected or overtouched accounts, spend spikes, drops and
//                            overspend, creative behind or quiet, sprint suggestions, unrecognized people, paused
//                            services, and (leads and execs) the Stripe check
//   pause_watched_service    a lead or exec: a service intentionally paused until a day, with the reason
//   close_watch_flag         mark a flag handled, or place a change-history name (team member, client's person, partner)
//   ask_creative_sprint      two extra creatives for an account beating its KPI
// Each opens on the Account watch page: open_screen place 'account watch' (or its tabs).

const accountWatch: AiTool = {
  name: "account_watch",
  description:
    "The account watch: services a client is billed for in Stripe (or listed on) with no activity for 7+ days (no spend, no creative delivered, no campaign sent, no post), ad accounts nobody on our team changed lately, accounts edited too often (learning resets), spend spikes, drops, stops and overspend, creative behind pace or quiet, accounts beating their KPI worth a creative sprint, unrecognized people in change history, services paused on purpose, and (leads and execs) where Kaizen OS services or creative packages don't match what Stripe bills. part: all, idle, accounts, creative, people, paused or billing; client: a client name to narrow it. Each flag has its id for close_watch_flag. To show it, open_screen place 'account watch' or 'account watch idle' / 'accounts' / 'creative' / 'people' / 'billing' / 'paused'.",
  input_schema: { type: "object", properties: { part: { type: "string", enum: ["all", "idle", "accounts", "creative", "people", "paused", "billing"] }, client: { type: "string" } }, additionalProperties: false },
  run: async (user: Staff, input) => {
    const { loadWatch, loadMismatches, WATCH_GROUP } = await import("@/lib/account-watch/load");
    const db = await createClient();
    const part = str(input.part) ?? "all";
    const client = str(input.client)?.toLowerCase() ?? null;
    const w = await loadWatch(db, user);
    const match = (name: string) => !client || name.toLowerCase().includes(client);
    const out: Record<string, unknown> = { ok: true, page: "/watch" };
    const groups = part === "all" ? ["idle", "accounts", "creative", "people"] : [part];
    for (const g of groups.filter((x) => x !== "paused" && x !== "billing"))
      out[g] = w.flags.filter((f) => WATCH_GROUP[f.kind] === g && match(f.client)).slice(0, 40).map((f) => ({ id: f.id, client: f.client, kind: f.kind, severity: f.severity, title: f.title, why: f.body, since: f.openedAt.slice(0, 10) }));
    if (part === "all" || part === "paused") out.paused = w.pauses.filter((p) => match(p.client)).map((p) => ({ client: p.client, service: p.service, until: p.until, reason: p.reason }));
    if ((part === "all" || part === "billing") && (user.isExec || user.isLead)) {
      const m = await loadMismatches(db);
      out.billing = { readFromStripeAt: m.syncedAt, mismatches: m.rows.filter((r) => match(r.client)).slice(0, 60).map((r) => ({ client: r.client, issue: r.text, fix: r.fix, service: r.service })) };
    }
    return out;
  },
};

const pauseWatched: AiTool = {
  name: "pause_watched_service",
  description:
    "A lead or exec: mark one client's service intentionally paused until a day, with the reason (a paintball park closed for winter, the client asked to hold Google until spring). The billed-but-idle alert for it closes and the watch leaves it alone until then. service: facebook-ads, google-ads, tiktok-ads, creative, email-marketing or social-media; until: YYYY-MM-DD. Say what you'll set and ask first.",
  input_schema: { type: "object", properties: { client: { type: "string" }, service: { type: "string" }, until: { type: "string" }, reason: { type: "string" } }, required: ["client", "service", "until", "reason"], additionalProperties: false },
  run: async (user: Staff, input) => {
    const db = await createClient();
    const name = str(input.client);
    if (!name) return { ok: false, error: "Which client?" };
    let c: { id: string; name: string }[];
    try {
      c = [await clientNamed(db, name)];
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : `No client called ${name}.` };
    }
    const { pauseService } = await import("@/lib/account-watch/act");
    return pauseService(createAdminClient(), user, { clientId: c[0].id as string, service: str(input.service) ?? "", until: str(input.until) ?? "", reason: str(input.reason) ?? "" });
  },
};

const closeFlag: AiTool = {
  name: "close_watch_flag",
  description:
    "Close an account watch flag (id from account_watch): how 'handled' with a note of what was done; or, for an unrecognized person in change history (leads and execs), how 'team' with team_member (their name: the change-history name becomes an alias on their profile), 'client' (the client's own person) or 'partner' (an outside partner or tool). Billed-but-idle flags are a lead's or exec's to close (or pause the service). Say what you'll do and ask first.",
  input_schema: { type: "object", properties: { id: { type: "string" }, how: { type: "string", enum: ["handled", "team", "client", "partner"] }, note: { type: "string" }, team_member: { type: "string" } }, required: ["id", "how"], additionalProperties: false },
  run: async (user: Staff, input) => {
    const act = await import("@/lib/account-watch/act");
    const admin = createAdminClient();
    const id = str(input.id) ?? "";
    const how = str(input.how);
    if (how === "handled") return act.resolveFlag(admin, user, id, str(input.note) ?? "");
    if (how === "team") {
      const who = str(input.team_member);
      if (!who) return { ok: false, error: "Which team member is it?" };
      const { data: p } = await admin.from("profiles").select("id, full_name").ilike("full_name", `%${who.replace(/[%_]/g, "")}%`).eq("is_active", true).limit(2);
      if (p?.length !== 1) return { ok: false, error: p?.length ? `More than one team member matches ${who}: ${p.map((x) => x.full_name).join(", ")}.` : `Nobody on the team called ${who}.` };
      return act.placeActor(admin, user, { flagId: id, as: "team", profileId: p[0].id as string });
    }
    if (how === "client" || how === "partner") return act.placeActor(admin, user, { flagId: id, as: how });
    return { ok: false, error: "how is handled, team, client or partner." };
  },
};

const askSprint: AiTool = {
  name: "ask_creative_sprint",
  description: "For an account beating its KPI by a wide margin (an account watch creative_sprint flag, id from account_watch): ask the head of creative and the client's designer and editor for two extra creatives this cycle. Ask first.",
  input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  run: async (user: Staff, input) => (await import("@/lib/account-watch/act")).requestSprint(createAdminClient(), user, str(input.id) ?? ""),
};

export const tools: AiTool[] = [accountWatch, pauseWatched, closeFlag, askSprint];
