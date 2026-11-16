import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { hostRedirect, hostsFrom } from "@/lib/hosts";
import { cookieDomain } from "@/lib/site";

// /api/cron/ (Vercel Cron) and /api/zapier/ (Zapier) check their own secrets; /p/ is a playbook share link (secret token, no names);
// /r/ is a client's monthly report link (secret token, read-only); /api/slack/events is Slack's (it checks Slack's
// signature); /api/portal-chat/avatar draws initials for Slack to show beside a client's portal message; /api/loom checks
// its own token (LOOM_WEBHOOK_TOKEN); /handled acts only with a signed link from a notice email (or as whoever's signed
// in); /api/email/inbound is Resend's (it checks the webhook signature); /api/connectors/client-metadata.json is Kaizen
// AI's OAuth Client ID Metadata Document, which a connector's sign in server fetches (public, no secret in it)
const PUBLIC_PATHS = ["/login", "/about", "/privacy", "/terms", "/auth/", "/p/", "/r/", "/api/cron/", "/api/zapier/", "/api/loom", "/api/slack/events", "/api/portal-chat/avatar", "/manifest.webmanifest", "/handled", "/api/email/inbound", "/api/connectors/client-metadata.json"];

// Refreshes the Supabase session cookie on every request and sends signed-out
// visitors to /login (keeping where they were headed). Real authorization is RLS.
export async function proxy(request: NextRequest) {
  // Each address serves its own part (lib/hosts.ts): the old ads. pages move to app. or portal., the portal lives on portal.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const moved = hostRedirect(host, request.nextUrl.pathname, hostsFrom());
  if (moved) {
    const res = NextResponse.redirect(`${moved.to}${request.nextUrl.pathname}${request.nextUrl.search}`, moved.status);
    // A sign in from before the move lives in a cookie only the old address holds; the shared one replaces it, so it's
    // cleared here (deleting without a domain only reaches that old, host-only cookie)
    for (const c of request.cookies.getAll()) if (c.name.startsWith("sb-")) res.cookies.set(c.name, "", { path: "/", maxAge: 0 });
    return res;
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookieOptions: { domain: cookieDomain(host) },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const signedIn = Boolean(data?.claims);
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PATHS.some((p) => path.startsWith(p));

  if (!signedIn && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = path === "/" ? "" : `?next=${encodeURIComponent(path + request.nextUrl.search)}`;
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|kaizen-logo.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp|otf|woff2?)$).*)"],
};
