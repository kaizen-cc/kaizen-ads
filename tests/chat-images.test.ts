import { describe, expect, it } from "vitest";
import { CHAT_IMAGE_MAX, chatImagesFrom } from "@/lib/chat-images";

const png = "data:image/png;base64,iVBORw0KGgo=";

describe("chatImagesFrom", () => {
  it("reads small pictures and drops everything else", () => {
    expect(chatImagesFrom([png, "data:text/html;base64,PGI+", "https://x.y/z.png", 4, null])).toEqual([{ mediaType: "image/png", data: "iVBORw0KGgo=" }]);
    expect(chatImagesFrom("nope")).toEqual([]);
  });
  it("caps the count", () => {
    expect(chatImagesFrom(Array.from({ length: 20 }, () => png))).toHaveLength(CHAT_IMAGE_MAX);
  });
});
