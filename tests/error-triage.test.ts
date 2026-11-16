import { describe, expect, it } from "vitest";
import { classifyError, isNavigationSignal } from "@/lib/error-triage";

describe("isNavigationSignal", () => {
  it("recognises Next.js redirect and not-found signals", () => {
    expect(isNavigationSignal("NEXT_REDIRECT")).toBe(true);
    expect(isNavigationSignal("", "NEXT_REDIRECT;replace;/login;307;")).toBe(true);
    expect(isNavigationSignal("NEXT_HTTP_ERROR_FALLBACK;404")).toBe(true);
    expect(isNavigationSignal("NEXT_NOT_FOUND")).toBe(true);
  });

  it("leaves real errors alone", () => {
    expect(isNavigationSignal("TypeError: x is undefined")).toBe(false);
    expect(isNavigationSignal("Failed after NEXT_REDIRECT")).toBe(false);
    expect(isNavigationSignal(null)).toBe(false);
    expect(classifyError("Failed to fetch")?.kind).toBe("network");
  });
});
