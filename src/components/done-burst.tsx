// The completion mark: a ring draws itself, the check draws in, and a soft pulse goes out. Pure CSS animation.

export function DoneBurst({ size = 96, color = "#5be3a5", label }: { size?: number; color?: string; label?: string }) {
  return (
    <div className="grid justify-items-center gap-3" role="status">
      <span className="relative grid place-items-center" style={{ width: size, height: size }}>
        <span aria-hidden className="absolute inset-0 rounded-full" style={{ background: color, animation: "kz-burst .9s ease-out .35s both" }} />
        <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden>
          <circle cx="32" cy="32" r="30" fill="none" stroke={color} strokeWidth="3" strokeDasharray="190" style={{ animation: "kz-ring .55s cubic-bezier(.2,.8,.2,1) both", transformOrigin: "center", transform: "rotate(-90deg)" }} />
          <path d="M20 33 l8 8 l16 -18" fill="none" stroke={color} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="48" style={{ animation: "kz-check-draw .4s cubic-bezier(.2,.8,.2,1) .4s both" }} />
        </svg>
      </span>
      {label && (
        <span className="text-sm font-medium" style={{ color, animation: "card-in .4s .5s both" }}>
          {label}
        </span>
      )}
    </div>
  );
}
