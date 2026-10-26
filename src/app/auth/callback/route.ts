import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeNext } from "@/lib/site";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");

  // Supabase sends ?error=... when the sign-up trigger rejects an uninvited email.
  const error = searchParams.get("error_description") ?? searchParams.get("error");
  if (error) {
    const reason = /database error|invitation|kaizenmarketing/i.test(error) ? "not_invited" : "failed";
    return NextResponse.redirect(`${origin}/login?error=${reason}`);
  }

  if (code) {
    const supabase = await createClient();
    const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
    if (!exchangeError) {
      // On the team's activity record (clients' sign-ins aren't: the function only logs staff)
      await supabase.rpc("activity_log", { p_kind: "sign_in", p_path: null, p_label: "Signed in" }).then(() => null, () => null);
      return NextResponse.redirect(`${origin}${safeNext(searchParams.get("next"))}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=failed`);
}
