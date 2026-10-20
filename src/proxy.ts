import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// /api/cron/ (Vercel Cron) and /api/zapier/ (Zapier) check their own secrets; /p/ is a playbook share link (secret token, no names);
// /r/ is a client's monthly report link (secret token, read-only)
const PUBLIC_PATHS = ["/login", "/auth/", "/p/", "/r/", "/api/cron/", "/api/zapier/", "/manifest.webmanifest"];

// Refreshes the Supabase session cookie on every request and sends signed-out
// visitors to /login (keeping where they were headed). Real authorization is RLS.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
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
