import { createBrowserClient } from "@supabase/ssr";
import { cookieDomain } from "@/lib/site";
import { parseViewAsCookie, VIEW_AS_COOKIE, VIEW_AS_HEADER } from "@/lib/view-as-core";

/** The teammate the owner is viewing as, from the cookie (the database checks it's really the owner asking) */
function viewAsId(): string | null {
  if (typeof document === "undefined") return null;
  const raw = document.cookie.split("; ").find((c) => c.startsWith(`${VIEW_AS_COOKIE}=`));
  return parseViewAsCookie(raw ? raw.slice(VIEW_AS_COOKIE.length + 1) : null)?.id ?? null;
}

export function createClient() {
  const id = viewAsId();
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookieOptions: { domain: cookieDomain(typeof window === "undefined" ? null : window.location.hostname) },
    // While viewing as someone the browser's reads answer as them too, and the database refuses its writes
    ...(id ? { global: { headers: { [VIEW_AS_HEADER]: id } } } : {}),
  });
}
