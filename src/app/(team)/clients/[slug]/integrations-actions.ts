"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { requireStaff } from "@/lib/auth";
import { connectIntegration, disconnectIntegration, syncIntegration, type IntegrationKind } from "@/lib/integrations";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// The team connects a client's store or CRM on the client page (never the client in a chat). Keys are tested, encrypted
// and never shown again.

type Result = { ok: true } | { ok: false; error: string };
const KINDS: IntegrationKind[] = ["shopify", "woocommerce", "gohighlevel", "hubspot", "other"];

async function mine(clientId: string) {
  const me = await requireStaff();
  if (!adminConfigured()) return { error: "Not set up here." } as const;
  const { data } = await (await createClient()).from("clients").select("id, slug").eq("id", clientId).maybeSingle();
  if (!data) return { error: "You don't work on this client." } as const;
  return { me, slug: data.slug as string, admin: createAdminClient() } as const;
}

export async function connectStore(clientId: string, input: { kind: IntegrationKind; account: string; secret: string; secret2?: string; label?: string }): Promise<Result> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  if (!KINDS.includes(input.kind)) return { ok: false, error: "Not found." };
  if (!input.account.trim() && input.kind !== "hubspot") return { ok: false, error: input.kind === "gohighlevel" ? "Add the location ID." : input.kind === "other" ? "Name the CRM." : "Add the store address." };
  const r = await connectIntegration(l.admin, clientId, input, l.me.id);
  if (!r.ok) return r;
  // The first pull right away (90 days back), after the answer
  const admin = l.admin;
  after(() => syncIntegration(admin, r.id).then(() => undefined));
  revalidatePath(`/clients/${l.slug}`);
  return { ok: true };
}

export async function disconnectStore(clientId: string, id: string): Promise<Result> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const { data } = await l.admin.from("client_integrations").select("id").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!data) return { ok: false, error: "Not found." };
  await disconnectIntegration(l.admin, id);
  revalidatePath(`/clients/${l.slug}`);
  return { ok: true };
}

export async function syncStoreNow(clientId: string, id: string): Promise<Result> {
  const l = await mine(clientId);
  if ("error" in l) return { ok: false, error: l.error! };
  const { data } = await l.admin.from("client_integrations").select("id").eq("id", id).eq("client_id", clientId).maybeSingle();
  if (!data) return { ok: false, error: "Not found." };
  const r = await syncIntegration(l.admin, id);
  revalidatePath(`/clients/${l.slug}`);
  return "error" in r && r.error ? { ok: false, error: String(r.error).slice(0, 200) } : { ok: true };
}
