"use client";

import { useEffect, useSyncExternalStore } from "react";
import { saveTheme, type Theme } from "@/app/(team)/theme-actions";

// Appearance: System (the device's setting), Light or Dark. The choice is applied before the page paints (the script in
// the root layout reads it from this device), and saved on the profile so it follows the person to their other devices.

const KEY = "kz-theme";
const html = () => document.documentElement;
const read = (): Theme => (html().dataset.theme as Theme | undefined) ?? "dark";
const subscribe = (fn: () => void) => {
  const o = new MutationObserver(fn);
  o.observe(html(), { attributes: true, attributeFilter: ["data-theme"] });
  return () => o.disconnect();
};
function apply(t: Theme) {
  html().dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // private window: it still applies for this visit
  }
}

const OPTIONS: { key: Theme; label: string; icon: string }[] = [
  { key: "system", label: "System", icon: "M3 5h18v11H3zM8 20h8M12 16v4" },
  { key: "light", label: "Light", icon: "M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z" },
  { key: "dark", label: "Dark", icon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" },
];

export function ThemeSwitch({ saved, size = "sm" }: { saved: Theme | null; size?: "sm" | "lg" }) {
  const theme = useSyncExternalStore(subscribe, read, () => saved ?? "dark");
  // The profile is the source of truth: a choice made on another device is picked up here
  useEffect(() => {
    if (saved && saved !== read()) apply(saved);
  }, [saved]);
  const pick = (t: Theme) => {
    apply(t);
    void saveTheme(t);
  };
  return (
    <div role="radiogroup" aria-label="Appearance" className="grid grid-cols-3 gap-0.5 rounded-full border border-line bg-bg p-0.5">
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={theme === o.key}
          title={o.label}
          onClick={() => pick(o.key)}
          className={`flex items-center justify-center gap-1.5 rounded-full transition-colors ${size === "lg" ? "h-10 text-sm" : "h-7 text-[11px]"} ${theme === o.key ? "bg-surface-2 text-fg shadow-sm" : "text-faint hover:text-fg"}`}
        >
          <svg width={size === "lg" ? 15 : 13} height={size === "lg" ? 15 : 13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={o.icon} />
          </svg>
          {o.label}
        </button>
      ))}
    </div>
  );
}
