import { describe, expect, it } from "vitest";
import { BRIEF_FILE_MAX, briefFileKind, briefFilePreview, briefFileProblem, briefFileUrl, clock, fileMention, ownPath, parseBriefFileUrl } from "@/lib/brief-files";

// Files added to a brief's conversation: the types and sizes we take, and their address on the brief.

describe("briefFileKind and briefFileProblem", () => {
  it("takes pictures, videos, audio and PDFs", () => {
    expect(briefFileKind("image/jpeg", "a.jpg")).toBe("image");
    expect(briefFileKind("image/webp", "a.webp")).toBe("image");
    expect(briefFileKind("", "shot.PNG")).toBe("image");
    expect(briefFileKind("video/quicktime", "clip.mov")).toBe("video");
    expect(briefFileKind("video/mp4", "clip.mp4")).toBe("video");
    expect(briefFileKind("audio/mpeg", "vo.mp3")).toBe("audio");
    expect(briefFileKind("audio/x-m4a", "memo.m4a")).toBe("audio");
    expect(briefFileKind("", "song.wav")).toBe("audio");
    expect(briefFileKind("application/pdf", "deck.pdf")).toBe("pdf");
  });
  it("turns down the rest", () => {
    expect(briefFileKind("image/gif", "a.gif")).toBeNull();
    expect(briefFileKind("image/heic", "a.heic")).toBeNull();
    expect(briefFileKind("application/zip", "a.zip")).toBeNull();
    expect(briefFileKind("video/webm", "a.webm")).toBeNull();
    expect(briefFileProblem({ name: "a.exe", mime: "application/octet-stream", bytes: 10 })).toMatch(/only/);
  });
  it("keeps sizes sane", () => {
    expect(briefFileProblem({ name: "a.jpg", mime: "image/jpeg", bytes: 2_000_000 })).toBeNull();
    expect(briefFileProblem({ name: "a.jpg", mime: "image/jpeg", bytes: BRIEF_FILE_MAX.image + 1 })).toMatch(/too big/);
    expect(briefFileProblem({ name: "a.mov", mime: "video/quicktime", bytes: BRIEF_FILE_MAX.video + 1 })).toMatch(/too big/);
    expect(briefFileProblem({ name: "a.pdf", mime: "application/pdf", bytes: 0 })).toMatch(/empty/);
  });
});

describe("the file on the brief", () => {
  const client = "11111111-2222-4333-8444-555555555555";
  const f = { path: `${client}/b1/00-launch.mov`, name: "launch.mov", kind: "video" as const, frames: [`${client}/b1/frame-01-0.jpg`] };
  it("is an address in the app that reads back", () => {
    const url = briefFileUrl("https://ads.example.com/", f);
    expect(url.startsWith(`https://ads.example.com/api/brief-files/${client}/b1/00-launch.mov?`)).toBe(true);
    expect(parseBriefFileUrl(url)).toEqual({ path: f.path, name: "launch.mov", kind: "video", thumb: f.frames[0] });
    expect(parseBriefFileUrl("https://example.com/other")).toBeNull();
    expect(parseBriefFileUrl("https://ads.example.com/api/brief-files/../secret")).toBeNull();
  });
  it("shows as a card with its picture", () => {
    const p = briefFilePreview(briefFileUrl("https://ads.example.com", f))!;
    expect(p.title).toBe("launch.mov");
    expect(p.thumbnail).toBe(`https://ads.example.com/api/brief-files/${f.frames[0]}`);
    const img = briefFileUrl("https://ads.example.com", { path: `${client}/b1/01-a.jpg`, name: "a.jpg", kind: "image" });
    expect(briefFilePreview(img)!.thumbnail).toBe(img);
    expect(briefFilePreview("https://www.pinterest.com/pin/1")).toBeNull();
  });
  it("only this client's own paths are read", () => {
    expect(ownPath(f.path, client)).toBe(true);
    expect(ownPath(`other/b1/x.jpg`, client)).toBe(false);
    expect(ownPath(`${client}/../x.jpg`, client)).toBe(false);
  });
  it("reads in a message", () => {
    expect(clock(42.4)).toBe("0:42");
    expect(fileMention({ name: "vo.mp3", kind: "audio", seconds: 75 })).toBe("[Audio: vo.mp3, 1:15]");
  });
});
