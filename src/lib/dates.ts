/** "Good morning" / "Good afternoon" / "Good evening" on Kaizen's clock (New York). */
export function greetingFor(date: Date) {
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: "America/New_York" }).format(date));
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

/** e.g. "Tuesday, October 13" in New York time. */
export const todayLabel = (date: Date) =>
  new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/New_York" }).format(date);

/** ISO timestamp for `days` calendar days ago. */
export const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export type Freshness = { label: string; tone: "ok" | "warn" | "off" };

/** "Synced 5 hours ago", green within a day, amber after, grey when it never ran. */
export function freshness(iso: string | null | undefined, verb = "Synced"): Freshness {
  if (!iso) return { label: "Not synced yet", tone: "off" };
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  const ago = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 48 * 60 ? `${Math.round(mins / 60)} hour${Math.round(mins / 60) === 1 ? "" : "s"} ago` : `${Math.round(mins / 1440)} days ago`;
  return { label: `${verb} ${ago}`, tone: mins <= 26 * 60 ? "ok" : "warn" };
}
