"use server";

import { headers } from "next/headers";
import { personFromCookies, reportError } from "@/lib/error-report";

/** A page crashed in someone's browser: record it (server errors are already caught on the server). */
export async function reportClientError(input: { message: string; path: string; stack?: string }) {
  const h = await headers();
  await reportError({
    message: String(input.message).slice(0, 500) || "Unknown browser error",
    path: String(input.path).slice(0, 300),
    kind: "page",
    person: await personFromCookies(h.get("cookie") ?? undefined),
    stack: input.stack?.slice(0, 4000),
    detail: { userAgent: h.get("user-agent") },
  });
}
