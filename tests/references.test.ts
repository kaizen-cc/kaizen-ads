import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/context/google", () => ({ driveToken: () => Promise.reject(new Error("not connected")) }));

const { classify, readReferences, referencesBlock } = await import("@/lib/references");

describe("reference reader", () => {
  it("knows Drive, Ads Library and websites apart", () => {
    expect(classify("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view")).toBe("drive");
    expect(classify("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit")).toBe("drive");
    expect(classify("https://www.facebook.com/ads/library/?id=123456789")).toBe("ads_library");
    expect(classify("https://limelightentertainmentnj.com/photography/")).toBe("website");
    expect(classify("not a link")).toBe("other");
  });

  it("never fetches the server's own network", async () => {
    const { reads } = await readReferences(["http://localhost:3000/admin", "http://169.254.169.254/latest/meta-data", "http://intranet/"]);
    expect(reads.every((r) => !r.ok && r.note === "Only public websites can be read")).toBe(true);
  });

  it("says plainly when Drive isn't available, instead of guessing", async () => {
    const { reads } = await readReferences(["https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view"]);
    expect(reads[0].ok).toBe(false);
    expect(referencesBlock(reads)).toMatch(/Couldn't be read: Google Drive isn't connected/);
  });
});
