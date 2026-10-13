import { initials } from "@/components/brand-switcher";

// One quiet tint per person, picked from their name, so faces are easy to tell apart in lists.
const TINTS = ["#b21e2c", "#7a4f9a", "#2f6f8f", "#3f7d5a", "#9a6a2f", "#5a5a8f", "#8f3f6a"];

export function PersonAvatar({ name, size = 32, muted = false }: { name: string; size?: number; muted?: boolean }) {
  const tint = TINTS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % TINTS.length];
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, background: muted ? "var(--surface-2)" : tint, fontSize: size * 0.36 }}
      className={`grid shrink-0 place-items-center rounded-full font-semibold ${muted ? "text-faint" : "text-white"}`}
    >
      {initials(name) || "?"}
    </span>
  );
}
