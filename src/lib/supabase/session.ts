import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { cookieDomain } from "@/lib/site";

/**
 * The signed-in person's own connection, as they are (no "view as"). lib/supabase/server's createClient() is the one the
 * app uses; this is what it builds on, and what view as uses to check who is really signed in.
 */
export async function createSessionClient(extra?: { headers?: Record<string, string>; fetch?: typeof fetch }) {
  const cookieStore = await cookies();
  const h = await headers();
  const domain = cookieDomain(h.get("x-forwarded-host") ?? h.get("host"));

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
    cookieOptions: { domain },
    ...(extra ? { global: { ...(extra.headers ? { headers: extra.headers } : {}), ...(extra.fetch ? { fetch: extra.fetch } : {}) } } : {}),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component — the proxy refreshes the session instead.
        }
      },
    },
  });
}
