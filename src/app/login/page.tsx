import Image from "next/image";
import { safeNext } from "@/lib/site";
import { EmailForm } from "./email-form";
import { GoogleButton } from "./google-button";

const errors: Record<string, string> = {
  not_invited:
    "You haven't been added to Kaizen Ads yet. Ask an executive to add your @kaizenmarketing.agency email, then try again.",
  inactive: "This account isn't active. Reach out to your Kaizen team if this is a mistake.",
  link_expired: "That sign-in link has expired or was already used. Enter your email for a new one.",
  failed: "Sign-in didn't complete. Please try again.",
};

export default async function Login({ searchParams }: PageProps<"/login">) {
  const { error, next } = await searchParams;
  const message = typeof error === "string" ? errors[error] : undefined;
  const nextPath = typeof next === "string" ? safeNext(next, "") || undefined : undefined;

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm rounded-brand border border-line bg-surface p-8">
        <div className="mb-8 flex items-center gap-2">
          <Image src="/kaizen-logo.png" alt="Kaizen" width={120} height={28} priority />
          <span className="mt-1 font-heading text-sm tracking-wide text-muted">ads</span>
        </div>
        <h1 className="font-heading text-xl md:text-2xl">Sign in</h1>
        <p className="mt-1 mb-6 text-sm text-muted">Review and approve your ads with Kaizen. No password needed.</p>

        {message && (
          <p className="mb-4 rounded-brand border border-brand bg-brand-soft px-3 py-2 text-sm">{message}</p>
        )}

        <EmailForm next={nextPath} />

        <div className="my-6 flex items-center gap-3 text-xs text-faint">
          <span className="h-px flex-1 bg-line" />
          Kaizen team
          <span className="h-px flex-1 bg-line" />
        </div>

        <GoogleButton next={nextPath} />

        <p className="mt-8 text-center text-xs text-faint">Get 1% better every day.</p>
      </div>
    </main>
  );
}
