import "server-only";
import { clientNamed } from "@/lib/client-named";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { seesAccountNumbers } from "@/lib/ai-access-core";
import { isProblem } from "@/lib/integration-health/core";
import { str, type AiTool } from "./types";

// Connection health for the assistant and agents (registered in src/lib/kaizen-ai/extensions.ts): a client's
// connections, or every client with one that's disconnected, erroring or stale. Clients the person can see only.

const health: AiTool = {
  name: "connection_health",
  description:
    "Whether a client's connections are working: each Meta, Google and TikTok ad account, Klaviyo (or Brevo, Customer.io), Shopify, the CRM (GoHighLevel, HubSpot), and Motion, as connected and fresh, stale, erroring or disconnected, with why. Without a client: every client with a connection problem. The afternoon before a client call the people on it are told about these automatically. open_screen place 'sync health' shows every client's; a client's own are on its Team & setup tab.",
  input_schema: { type: "object", properties: { client: { type: "string" } }, additionalProperties: false },
  run: async (user, input) => {
    if (!seesAccountNumbers(user)) return { ok: false, error: "Account numbers aren't part of your view." };
    const db = await createClient();
    const { integrationHealth } = await import("@/lib/integration-health/load");
    const name = str(input.client);
    if (name) {
      let c: { id: string; name: string; slug: string };
      try {
        c = await clientNamed(db, name);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : "Which client?" };
      }
      const [h] = await integrationHealth(createAdminClient(), { clientIds: [c.id] });
      return { ok: true, client: c.name, page: `/clients/${c.slug}?tab=team#connections`, connections: (h?.items ?? []).map((x) => ({ what: x.label, state: x.state, detail: x.detail })) };
    }
    // Every client this person can see (their session decides), with a problem
    const { data: visible } = await db.from("clients").select("id").is("archived_at", null).limit(2000);
    const all = await integrationHealth(createAdminClient(), { clientIds: (visible ?? []).map((v) => v.id as string) });
    const bad = all.map((c) => ({ client: c.client, problems: c.items.filter(isProblem).map((x) => ({ what: x.label, state: x.state, detail: x.detail })) })).filter((c) => c.problems.length);
    return { ok: true, page: "/settings?tab=sync", clients: bad.length, list: bad.slice(0, 40) };
  },
};

export const tools: AiTool[] = [health];
