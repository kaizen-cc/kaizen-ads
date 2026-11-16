import { createBrowserClient } from "@supabase/ssr";
import { cookieDomain } from "@/lib/site";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    { cookieOptions: { domain: cookieDomain(typeof window === "undefined" ? null : window.location.hostname) } },
  );
}
