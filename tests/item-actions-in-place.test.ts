import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { refreshInPlace } from "@/lib/complete-card";

// Owner, Nov 25 2026: after Done or Later the page refetched twice and jumped to the top. Item actions take the item
// off the screen themselves (src/lib/undo.ts deferClear) and refresh in place; the server never redraws the whole page.
const src = (p: string) => readFileSync(p, "utf8");

describe("item actions never redraw the whole page", () => {
  it("Done, Not for me and Later write without a page-wide revalidate", () => {
    const today = src("src/app/today/actions.ts");
    expect(today).toMatch(/markItem\(db, me\.id, key, status, snap, \{ skip: own, revalidate: false \}\)/);
    expect(today).not.toMatch(/reviewsChanged\(\)/);
    const quick = src("src/app/(team)/item-actions.ts");
    expect(quick).toMatch(/snoozeItem\(.*, undefined, false\)/);
    // Transfer and change due: the screen refreshes in place
    const transfer = quick.slice(quick.indexOf("export async function transferQuickItem"), quick.indexOf("export async function dueQuickItem"));
    expect(transfer).not.toMatch(/revalidateDay\(\)/);
    const due = quick.slice(quick.indexOf("export async function dueQuickItem"), quick.indexOf("export async function takeOverQuickItem"));
    expect(due).not.toMatch(/revalidateDay\(\)/);
    expect(src("src/app/(team)/asana-task-actions.ts")).not.toMatch(/revalidatePath\(/);
  });

  it("the item controls refresh in place, never a bare router.refresh()", () => {
    for (const p of ["src/components/item-quick-actions.tsx", "src/components/sub-items.tsx", "src/components/asana-item-actions.tsx", "src/app/(team)/pipeline/views/exec-home.tsx", "src/components/stepins/deck.tsx"]) {
      expect(src(p), p).not.toMatch(/router\.refresh\(\)/);
    }
  });

  it("Later in the recap deck is a snooze that leaves the list (not a 'Saved for later' label)", () => {
    const story = src("src/app/today/story.tsx");
    expect(story).toMatch(/if \(status === "saved"\) return snoozeQuickItem\(i\.key, snap\(i\)\)/);
    expect(story).toMatch(/status === "saved" \? "snoozed" : status/);
    expect(story).not.toMatch(/"Saved for later" :/);
  });
});

describe("refreshInPlace", () => {
  it("puts the page back where it was when a redraw jumps it to the top", () => {
    const listeners = new Map<string, () => void>();
    let y = 1400;
    const frames: (() => void)[] = [];
    const win = {
      get scrollY() {
        return y;
      },
      scrollTo: vi.fn(({ top }: { top: number }) => (y = top)),
      addEventListener: (t: string, f: () => void) => listeners.set(t, f),
      removeEventListener: (t: string) => listeners.delete(t),
    };
    vi.stubGlobal("window", win);
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => frames.push(f));
    // The redraw jumps the page to the top
    refreshInPlace({ refresh: () => (y = 0) });
    frames.shift()?.();
    expect(win.scrollTo).toHaveBeenCalledWith({ top: 1400 });
    expect(y).toBe(1400);
    // Scrolled by the person themselves: left alone
    y = 300;
    listeners.get("wheel")?.();
    frames.shift()?.();
    expect(y).toBe(300);
    vi.unstubAllGlobals();
  });
});
