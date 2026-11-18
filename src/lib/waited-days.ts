// How many business days something has waited, for the onboarding cards on Pipeline. Counted in New York time, never
// the device's: the server renders in UTC and the browser in the viewer's own zone, and if the two counted differently
// ("1 day so far" vs "2 days so far") the page failed to hydrate (React error #418).

const DAY = 86_400_000;
const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "America/New_York" });

/** Whole 24-hour steps from a moment up to `now` that land on a weekday in New York (weekends don't count) */
export function businessDaysSince(iso: string, now: number) {
  const start = Date.parse(iso);
  if (!Number.isFinite(start)) return 0;
  let days = 0;
  for (let t = start + DAY; t <= now && days < 400; t += DAY) {
    const wd = weekday.format(t);
    if (wd !== "Sat" && wd !== "Sun") days++;
  }
  return days;
}
