"use client";

import { useEffect, useRef, useState } from "react";
import "./logo-loader.css";

// The Kaizen mark as a little character, doing something silly while a page loads. It picks a scene after it mounts
// (the server renders a neutral, blinking mark, so nothing mismatches) and moves on to another one every few seconds
// if the wait runs long. Pure SVG and CSS: the mark is redrawn as four parts (head bar, arm, two legs) so they can move.

export type LoaderScene = "cook" | "read" | "laptop" | "sleep" | "eat" | "watch" | "stare" | "spin";
export const LOADER_SCENES: LoaderScene[] = ["cook", "read", "laptop", "sleep", "eat", "watch", "stare", "spin"];

export const LOADER_CAPTIONS: Record<LoaderScene, string[]> = {
  cook: ["Cooking up your numbers", "Letting the insights simmer", "Flipping the data, one side at a time"],
  read: ["Reading every ad so you don't have to", "Skimming the fine print", "Almost at the good part"],
  laptop: ["Asking Meta nicely", "Typing very important things", "Refreshing. Refreshing. Refreshing."],
  sleep: ["Five more minutes…", "Resting my eyes, not asleep", "Dreaming of lower CPAs"],
  eat: ["Snack break, almost done", "Slurping through the spreadsheets", "Fueling up for your data"],
  watch: ["Watching your ads. Again.", "Ooh, this part is good", "Popcorn for the plot twist"],
  stare: ["Just a sec. Staring contest.", "I see you waiting", "Don't blink"],
  spin: ["Spinning up your page", "Showing off while it loads", "One more spin, promise"],
};

const SIZES = { sm: { w: 64, text: "text-xs", gap: "gap-1.5" }, md: { w: 124, text: "text-sm", gap: "gap-2.5" }, lg: { w: 184, text: "text-base", gap: "gap-3" } };
const CYCLE_MS = 4600;
const RED = "#b21e2c";
const PUPIL = "#16131a";
const pick = <T,>(xs: T[], not?: T) => {
  const pool = xs.length > 1 && not !== undefined ? xs.filter((x) => x !== not) : xs;
  return pool[Math.floor(Math.random() * pool.length)];
};

type Props = {
  /** Shown instead of the scene's joke, e.g. "Opening your day" */
  label?: string;
  size?: keyof typeof SIZES;
  /** Force one scene (no cycling) */
  scene?: LoaderScene;
  /** No caption line under the mark (still read out to screen readers) */
  hideCaption?: boolean;
  /** On a always-dark stage regardless of the theme */
  onDark?: boolean;
  className?: string;
};

export function LogoLoader({ label, size = "md", scene: forced, hideCaption, onDark, className = "" }: Props) {
  const [state, setState] = useState<{ scene: LoaderScene | null; caption: string | null }>({ scene: forced ?? null, caption: null });
  const look = useRef<SVGGElement>(null);
  const svg = useRef<SVGSVGElement>(null);

  // Pick after mount (random can't run on the server without a mismatch), then rotate while the wait lasts
  useEffect(() => {
    const next = (prev: LoaderScene | null) => {
      const scene = forced ?? pick(LOADER_SCENES, prev ?? undefined);
      return { scene, caption: pick(LOADER_CAPTIONS[scene]) };
    };
    const first = setTimeout(() => setState((s) => next(s.scene)), 0);
    const cycle = forced ? undefined : setInterval(() => setState((s) => next(s.scene)), CYCLE_MS);
    return () => {
      clearTimeout(first);
      if (cycle) clearInterval(cycle);
    };
  }, [forced]);

  // Staring: the eyes follow the pointer on desktop (touch screens get a slow drift from the CSS instead)
  const scene = state.scene;
  useEffect(() => {
    if (scene !== "stare" || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const el = look.current;
    const onMove = (e: PointerEvent) => {
      const r = svg.current?.getBoundingClientRect();
      if (!r || !el) return;
      const dx = e.clientX - (r.left + r.width * 0.45);
      const dy = e.clientY - (r.top + r.height * 0.45);
      const d = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, d / 260);
      el.style.transform = `translate(${((dx / d) * 7 * k).toFixed(2)}px, ${((dy / d) * 6 * k).toFixed(2)}px)`;
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (el) el.style.transform = "";
    };
  }, [scene]);

  const s = SIZES[size];
  const caption = label ?? state.caption ?? "Loading";
  const vars = onDark ? ({ "--fg": "#f2f2f2", "--fg-muted": "#9a9aa2", "--fg-faint": "#6a6a72", "--surface": "#101011", "--surface-2": "#18181a", "--border": "#26262a" } as React.CSSProperties) : undefined;

  return (
    <div role="status" aria-live="polite" className={`kzl grid justify-items-center ${s.gap} ${className}`} data-scene={scene ?? "idle"} style={vars}>
      <svg ref={svg} viewBox="-20 30 620 410" width={s.w} height={Math.round((s.w * 410) / 620)} aria-hidden className="block overflow-visible">
        {scene === "sleep" && (
          <g className="kz-prop" fill="var(--fg-muted)" fontWeight={800} fontFamily="ui-rounded, system-ui, sans-serif">
            <text className="kz-z" x="470" y="110" fontSize="34">z</text>
            <text className="kz-z kz-d2" x="500" y="90" fontSize="44">z</text>
            <text className="kz-z kz-d3" x="535" y="70" fontSize="56">Z</text>
          </g>
        )}
        {scene === "laptop" && (
          <g className="kz-prop kz-bubble">
            <path d="M40 60h130a22 22 0 0 1 22 22v28a22 22 0 0 1-22 22h-70l-26 22 4-22H40a22 22 0 0 1-22-22V82a22 22 0 0 1 22-22z" fill="var(--surface-2)" stroke="var(--border)" strokeWidth="4" />
            {[70, 105, 140].map((x, i) => (
              <circle key={x} className={`kz-dot kz-d${i + 1}`} cx={x} cy="96" r="9" fill="var(--fg-muted)" />
            ))}
          </g>
        )}
        <g className="kz-char">
          <g className="kz-leg-l">
            <path d="M160 250h39l-9 42v108h-65V302q0-15 9-25z" fill={RED} />
          </g>
          <g className="kz-leg-r">
            <path d="M205 250h65v78q0 20 20 20h172v62H336q-18 0-31-13l-88-88q-12-12-12-28z" fill={RED} />
            {scene === "watch" && (
              <g className="kz-prop">
                <circle className="kz-kernel" cx="426" cy="270" r="8" fill="#fff3cf" />
                {[408, 421, 434, 446, 427].map((x, i) => (
                  <circle key={i} cx={x} cy={i === 4 ? 268 : 280 - (i % 2) * 5} r="10" fill="#fff3cf" stroke="#e6d39b" strokeWidth="2" />
                ))}
                <path d="M398 282h58l-7 64h-44z" fill="#fff" />
                <path d="M411 282h9l-1 64h-7zM434 282h9l-3 64h-7z" fill={RED} />
              </g>
            )}
          </g>
          <g className="kz-arm">
            <path d="M398 103h64v97h-64z" fill={RED} />
            {scene === "cook" && (
              <g className="kz-prop">
                <path d="M462 140h44" stroke="var(--fg-muted)" strokeWidth="9" strokeLinecap="round" />
                <path d="M500 128h84q-4 30-42 30t-42-30z" fill="var(--fg-muted)" />
                <ellipse className="kz-cake" cx="542" cy="122" rx="30" ry="7" fill="#e9b65a" />
                {[520, 542, 564].map((x, i) => (
                  <path key={x} className={`kz-steam kz-d${i + 1}`} d={`M${x} 104q-8-11 0-22t0-22`} fill="none" stroke="var(--fg-faint)" strokeWidth="4" strokeLinecap="round" />
                ))}
              </g>
            )}
            {scene === "eat" && (
              <g className="kz-prop" stroke="#c8955a" strokeWidth="6" strokeLinecap="round">
                <path d="M452 168 330 292M466 176 342 298" />
              </g>
            )}
          </g>
          <g className="kz-head">
            <path d="M55 196q0-7 11-7h396v7q0 15-12 26l-19 18q-11 10-29 10H55z" fill={RED} />
            {(scene === "laptop" || scene === "watch") && <ellipse className="kz-prop kz-glow" cx="272" cy="220" rx="96" ry="24" fill={scene === "laptop" ? "#8ab4f8" : "#c9d2ff"} />}
            {scene === "sleep" ? (
              <g stroke="#fff" strokeWidth="5" fill="none" strokeLinecap="round">
                <path d="M222 220q18 11 36 0M284 220q18 11 36 0" />
              </g>
            ) : (
              <g className="kz-eyes">
                <circle cx="240" cy="219" r="20" fill="#fff" />
                <circle cx="302" cy="219" r="20" fill="#fff" />
                <g ref={look} className="kz-look">
                  <g className="kz-pupils" fill={PUPIL}>
                    <circle cx="241" cy="220" r="9.5" />
                    <circle cx="303" cy="220" r="9.5" />
                  </g>
                </g>
              </g>
            )}
            {scene === "stare" && <path className="kz-brow" d="M288 195l30-4" stroke="var(--fg)" strokeWidth="5" strokeLinecap="round" />}
            {scene === "eat" && <ellipse className="kz-mouth" cx="352" cy="238" rx="9" ry="6" fill="#3a0d12" />}
            {scene === "sleep" && <circle className="kz-prop kz-snot" cx="50" cy="236" r="14" fill="rgba(170,210,255,.35)" stroke="rgba(220,235,255,.8)" strokeWidth="3" />}
          </g>
          {scene === "read" && (
            <g className="kz-prop">
              <path d="M186 266l84 12 84-12v66l-84 12-84-12z" fill="#5b8def" />
              <path d="M196 262l74 12v60l-74-10z" fill="#f4efe6" stroke="#cfc8bb" strokeWidth="2" />
              <path d="M206 280l52 7M206 294l52 7M206 308l40 5" stroke="#bdb4a5" strokeWidth="3" />
              <path d="M270 274l74-12v62l-74 10z" fill="#f4efe6" stroke="#cfc8bb" strokeWidth="2" />
              <path className="kz-page" d="M270 274l74-12v62l-74 10z" fill="#fbf8f2" stroke="#cfc8bb" strokeWidth="2" />
            </g>
          )}
          {scene === "laptop" && (
            <g className="kz-prop">
              <rect x="172" y="262" width="176" height="94" rx="10" fill="var(--fg-muted)" />
              <circle cx="260" cy="309" r="10" fill="var(--surface-2)" />
              <rect x="152" y="354" width="216" height="12" rx="5" fill="var(--fg-faint)" />
            </g>
          )}
          {scene === "eat" && (
            <g className="kz-prop">
              <path className="kz-noodle" d="M300 298c-12-18 32-26 18-40s30-14 34-20" fill="none" stroke="#f2d27a" strokeWidth="5" strokeLinecap="round" />
              <path d="M178 300h184q-6 64-92 64t-92-64z" fill="var(--fg-muted)" />
              <ellipse cx="270" cy="300" rx="92" ry="9" fill="#f2d27a" />
              <circle className="kz-crumb" cx="366" cy="246" r="4" fill="#f2d27a" />
              <circle className="kz-crumb kz-d2" cx="360" cy="250" r="3" fill="#f2d27a" />
            </g>
          )}
        </g>
        {scene === "spin" && (
          <g className="kz-prop kz-whoosh" fill="none" stroke="var(--fg-faint)" strokeWidth="5" strokeLinecap="round">
            <path d="M30 330q-20-60 10-120M520 330q24-60-6-130M90 424q180 26 340 0" />
          </g>
        )}
      </svg>
      {hideCaption ? (
        <span className="sr-only">{caption}</span>
      ) : (
        <p className={`kz-cap h-[1.5em] max-w-[90vw] truncate text-center leading-[1.5] tracking-wide text-muted ${s.text}`} key={caption}>
          {caption}
        </p>
      )}
    </div>
  );
}
