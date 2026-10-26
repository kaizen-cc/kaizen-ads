"use client";

import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

// Overlays (dialogs, sheets, the AI drawer) render on <body>: the page's <main> is its own stacking context, so on
// phones anything fixed inside it would sit under the app's top bar and tab bar. On desktop they look the same.

const never = () => () => {};

export function Layer({ children }: { children: React.ReactNode }) {
  const mounted = useSyncExternalStore(
    never,
    () => true,
    () => false,
  );
  return mounted ? createPortal(children, document.body) : null;
}
