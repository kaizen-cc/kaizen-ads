// Where the call widget sits: dragged anywhere on screen (kept inside it), nudged with the arrow keys, remembered per
// device, and on phones the collapsed pill snaps to the nearer side. Pure: no DOM, tested on its own.

export type Pos = { x: number; y: number };
export type Size = { w: number; h: number };

/** Kept fully on screen, `margin` from each edge (a widget bigger than the screen sits at the top left margin) */
export function clampDock(p: Pos, size: Size, view: Size, margin = 8): Pos {
  const maxX = Math.max(margin, view.w - size.w - margin);
  const maxY = Math.max(margin, view.h - size.h - margin);
  return { x: Math.round(Math.min(maxX, Math.max(margin, p.x))), y: Math.round(Math.min(maxY, Math.max(margin, p.y))) };
}

/** Phones: the pill goes to the nearer side, at the height it was dropped */
export function snapToEdge(p: Pos, size: Size, view: Size, margin = 12): Pos {
  const left = p.x + size.w / 2 < view.w / 2;
  return clampDock({ x: left ? margin : view.w - size.w - margin, y: p.y }, size, view, margin);
}

/** An arrow key moves it a step (Shift: a bigger one); anything else isn't a move */
export function nudge(p: Pos, key: string, big = false): Pos | null {
  const s = big ? 64 : 16;
  switch (key) {
    case "ArrowLeft":
      return { x: p.x - s, y: p.y };
    case "ArrowRight":
      return { x: p.x + s, y: p.y };
    case "ArrowUp":
      return { x: p.x, y: p.y - s };
    case "ArrowDown":
      return { x: p.x, y: p.y + s };
    default:
      return null;
  }
}

/** Far enough to be a drag, not a tap (so tapping the pill still opens it) */
export const DRAG_THRESHOLD = 5;
export const moved = (a: Pos, b: Pos) => Math.hypot(a.x - b.x, a.y - b.y) >= DRAG_THRESHOLD;

/** Where it's remembered in this browser, per device */
export const dockKey = (device: "desktop" | "phone") => `kz:call-dock:${device}`;

/** A remembered spot, or null when there's none or it's junk */
export function parsePos(raw: string | null | undefined): Pos | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { x?: unknown; y?: unknown };
    return typeof v.x === "number" && typeof v.y === "number" && Number.isFinite(v.x) && Number.isFinite(v.y) ? { x: v.x, y: v.y } : null;
  } catch {
    return null;
  }
}
