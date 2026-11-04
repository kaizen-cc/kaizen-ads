import Image from "next/image";
import Link from "next/link";

// The public pages: what Kaizen Ads is, its privacy policy and terms (the OAuth consent screen and Google's reviews link here)
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 pb-4 pt-8 md:px-6">
        <Link href="/about" className="flex items-center gap-2">
          <Image src="/kaizen-logo.png" alt="Kaizen Marketing" width={120} height={28} priority />
          <span className="mt-1 font-display text-sm tracking-wide text-muted">ads</span>
        </Link>
        <Link href="/login" className="inline-flex min-h-11 items-center rounded-full border border-line px-4 text-[14px] text-muted hover:text-fg">
          Sign in
        </Link>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-16 md:px-6">{children}</main>
      <footer className="mx-auto flex max-w-3xl flex-wrap gap-x-5 gap-y-2 border-t border-line px-4 py-6 text-[13px] text-muted md:px-6">
        <span>© {new Date().getFullYear()} Kaizen Marketing</span>
        <Link href="/about" className="hover:text-fg">About Kaizen Ads</Link>
        <Link href="/privacy" className="hover:text-fg">Privacy policy</Link>
        <Link href="/terms" className="hover:text-fg">Terms of service</Link>
        <a href="mailto:santi@kaizenmarketing.agency" className="hover:text-fg">Contact</a>
      </footer>
    </div>
  );
}
