import type { Metadata } from "next";
import { requireStaff } from "@/lib/auth";
import { INDUSTRY_OPTIONS } from "@/lib/industries";
import { allWinners } from "@/lib/industry";
import { adminConfigured, createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { WinnersLibrary } from "./winners-library";

export const metadata: Metadata = { title: "Winners" };

export default async function Winners() {
  await requireStaff();
  // Every account's numbers, whoever is looking: the point is learning from clients you don't work on
  const db = adminConfigured() ? createAdminClient() : await createClient();
  const winners = await allWinners(db);
  return (
    <div className="mx-auto max-w-6xl">
      <WinnersLibrary winners={winners} industries={INDUSTRY_OPTIONS} />
    </div>
  );
}
