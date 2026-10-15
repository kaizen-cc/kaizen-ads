// The industries a client can be in (shared by the server and the client page).

export const INDUSTRIES = [
  ["restaurant", "Restaurants & food"],
  ["home_services", "Home services & improvement"],
  ["dental", "Dental"],
  ["medical", "Medical & healthcare"],
  ["med_spa", "Med spa & beauty"],
  ["fitness", "Fitness & wellness"],
  ["automotive", "Automotive"],
  ["real_estate", "Real estate"],
  ["legal", "Legal"],
  ["financial", "Financial services & insurance"],
  ["ecommerce", "E-commerce & retail"],
  ["cpg", "Consumer products"],
  ["education", "Education & coaching"],
  ["entertainment", "Entertainment & events"],
  ["hospitality", "Hospitality & travel"],
  ["professional", "Professional & B2B services"],
  ["nonprofit", "Nonprofit"],
  ["other", "Other"],
] as const;
export type Industry = (typeof INDUSTRIES)[number][0];
export const industryLabel = (k: string | null | undefined) => INDUSTRIES.find(([key]) => key === k)?.[1] ?? null;

/** For pickers: [key, label] pairs. */
export const INDUSTRY_OPTIONS = INDUSTRIES;
