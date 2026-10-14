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
