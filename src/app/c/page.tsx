import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { BrandAvatar } from "@/components/brand-switcher";
import { getViewer } from "@/lib/auth";

// A contact with several brands picks one here after signing in directly.
export default async function BrandPicker() {
  const viewer = await getViewer();
  if (viewer.kind === "staff") redirect("/clients");
  if (viewer.brands.length === 1) redirect(`/c/${viewer.brands[0].slug}`);

  return (
    <main className="mx-auto grid max-w-md gap-6 px-4 py-10 pt-[max(2.5rem,env(safe-area-inset-top))] pb-[max(2.5rem,env(safe-area-inset-bottom))]">
      <div className="flex items-center gap-2">
        <Image src="/kaizen-logo.png" alt="Kaizen" width={100} height={24} />
        <span className="mt-0.5 font-display text-xs tracking-wide text-muted">ads</span>
      </div>
      <div>
        <h1 className="font-heading text-2xl">Which brand?</h1>
        <p className="mt-1 text-sm text-muted">You have access to {viewer.brands.length} brands. You can switch any time from the top of the page.</p>
      </div>
      {viewer.brands.length === 0 ? (
        <p className="rounded-brand border border-line bg-surface p-4 text-sm text-muted">
          Your email isn&apos;t linked to a brand right now. Reach out to your Kaizen team and they&apos;ll add you.
        </p>
      ) : (
        <ul className="grid gap-2">
          {viewer.brands.map((b) => (
            <li key={b.slug}>
              <Link href={`/c/${b.slug}`} className="flex items-center gap-3 rounded-brand border border-line bg-surface p-4 hover:border-faint active:bg-surface-2">
                <BrandAvatar name={b.name} size={36} />
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{b.name}</span>
                <span className="ml-auto text-muted">→</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <form action="/auth/signout" method="post">
        <button className="text-xs text-muted hover:text-fg max-md:min-h-11">Sign out</button>
      </form>
    </main>
  );
}
