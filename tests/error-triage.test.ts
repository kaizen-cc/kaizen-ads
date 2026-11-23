import { describe, expect, it } from "vitest";
import { actionFailedText, classifyError, isNavigationSignal } from "@/lib/error-triage";

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

describe("actionFailedText", () => {
  it("puts a failed action request in plain words", () => {
    expect(actionFailedText(new Error("An unexpected response was received from the server."))).toMatch(/didn't finish/);
    expect(actionFailedText(new TypeError("Failed to fetch"))).toMatch(/connection dropped/);
    expect(actionFailedText(new Error('Server Action "abc" was not found on the server.'))).toMatch(/Refresh the page/);
    expect(actionFailedText(undefined)).toMatch(/try again/);
  });
});
