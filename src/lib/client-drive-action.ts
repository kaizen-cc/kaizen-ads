"use server";

import { requireStaff } from "@/lib/auth";
import { clientDriveOf, type ClientDrive } from "@/lib/brief-cards";
import { createClient } from "@/lib/supabase/server";

/**
 * The client's Drive headquarters and Ad Creatives folder links, for the brief on screen (Ready to send and the ticket),
 * so the maker can browse the whole Drive. Read as the person (RLS decides whether they see the client); null otherwise.
 */
export async function clientDriveLinks(clientId: string): Promise<ClientDrive | null> {
  await requireStaff();
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return null;
  const { data } = await (await createClient()).from("clients").select("drive_folder_id, ad_creative_folder_id").eq("id", clientId).maybeSingle();
  return data ? clientDriveOf(data as { drive_folder_id: string | null; ad_creative_folder_id: string | null }) : null;
}
