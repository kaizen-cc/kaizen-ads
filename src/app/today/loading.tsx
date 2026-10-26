// Shown the instant "Start your day" is clicked, while the review opens: the recap's own dark stage, so the click
// answers at once and the first card fades in over it.
export default function Loading() {
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-[#07060a] text-white [color-scheme:dark]">
      <div aria-hidden className="pointer-events-none absolute left-1/2 top-1/3 h-[420px] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[rgba(200,16,46,0.35)] blur-[120px]" />
      <div className="relative grid justify-items-center gap-4">
        <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/70 border-t-transparent" />
        <p className="text-sm tracking-wide text-white/60">Opening your day…</p>
      </div>
    </div>
  );
}
