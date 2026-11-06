import { LogoLoader } from "@/components/logo-loader";

// Shown the instant a client is clicked while its data loads (and what Next.js prefetches for each client link, so
// the switch itself is immediate): the Kaizen mark keeping busy, centred in the content area
export default function Loading() {
  return (
    <div className="grid min-h-[60vh] place-items-center" aria-busy="true">
      <LogoLoader size="lg" />
    </div>
  );
}
