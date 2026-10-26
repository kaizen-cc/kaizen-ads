// Meta's standard conversion events an ad set can optimize for (shared by the launcher and its screens)
export const EVENTS = ["PURCHASE", "LEAD", "COMPLETE_REGISTRATION", "SCHEDULE", "CONTACT", "SUBMIT_APPLICATION", "SUBSCRIBE", "START_TRIAL", "ADD_TO_CART", "INITIATED_CHECKOUT", "ADD_PAYMENT_INFO", "VIEW_CONTENT", "SEARCH", "OTHER"];
export const eventLabel = (e: string) => e.replace(/_/g, " ").toLowerCase().replace(/^./, (x) => x.toUpperCase());

/** How long since a dataset last saw an event, in words */
export const firedAgo = (iso: string | null) => {
  if (!iso) return "no events yet";
  const h = Math.round((Date.now() - Date.parse(iso)) / 3_600_000);
  return h < 1 ? "event in the last hour" : h < 48 ? `last event ${h}h ago` : `last event ${Math.round(h / 24)} days ago`;
};
