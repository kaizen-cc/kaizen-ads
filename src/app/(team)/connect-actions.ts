"use server";

import { cookies } from "next/headers";
import { requireStaff } from "@/lib/auth";
import { SNOOZE_COOKIE } from "@/lib/connect-required-core";

// "Remind me tomorrow" on the first-run Connect screen: hidden until tomorrow (New York time). The Overview's critical
// item and the assistant's daily reminder stay until they connect.

export async function remindTomorrow(): Promise<{ ok: true }> {
  await requireStaff();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  (await cookies()).set(SNOOZE_COOKIE, today, { path: "/", maxAge: 60 * 60 * 36, sameSite: "lax", httpOnly: true, secure: true });
  return { ok: true };
}
