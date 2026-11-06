import { LogoLoader } from "@/components/logo-loader";

// Shown the instant a client moves between their portal's pages, while the next one loads
export default function Loading() {
  return (
    <div className="grid min-h-[55vh] place-items-center" aria-busy="true">
      <LogoLoader size="lg" />
    </div>
  );
}
