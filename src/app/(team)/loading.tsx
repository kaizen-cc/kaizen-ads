import { LogoLoader } from "@/components/logo-loader";

// Shown the moment a tab is clicked, while the page's data loads: the Kaizen mark doing something silly, centred in
// the content area. With it, Next.js also prefetches each tab's shell ahead of time, so the switch itself is instant.
export default function Loading() {
  return (
    <div className="grid min-h-[60vh] place-items-center" aria-busy="true">
      <LogoLoader size="lg" />
    </div>
  );
}
