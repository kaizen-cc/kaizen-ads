@AGENTS.md

# Kaizen OS: rules for every change

## Mobile first, at every size (owner, standing rule)
Everything built in Kaizen OS must work and feel like a native app on phones, and on every size in between. This applies to all new work and to anything you touch.
- Design at phone width first (375px), then check 320, 390, 430, tablet (768) and desktop.
- **No clipped content:** nothing may be cut off or unreachable. Every control must be reachable by scrolling, and no card, deck, sheet or panel may hide content behind a fixed height or `overflow: hidden` on a phone.
- **No horizontal page scroll.** Tables collapse to cards. Long text wraps.
- **Touch and input:** touch targets are at least 44px on phones, and inputs use at least a 16px font (no iOS zoom).
- **Layout on phones:** sheets and drawers open full-screen, primary actions sit within thumb reach, and safe-area insets are respected.
- Use the app shell's mobile header and hamburger drawer (`src/components/team-shell.tsx`).
- **Verify before pushing:** for any screen you add or change, check it at phone width and desktop width (the browser preview's resize). Say in your report which widths you checked.

## Also
- **Theme:** light and dark use the theme tokens (`ink`, `deep`, `fg`, `line`, `surface`, `muted`). Never hardcode white or a dark hex.
- **External links:** links outside Kaizen OS (Slack, Gmail, Asana, Drive, ad managers, Klaviyo, Figma, client sites) open in a new tab. In-app links stay in the tab.
- **Back button:** tabs, sheets, open blocks and filters live in the URL (pushState), so the browser's back button returns there.
- **Server and client files:** a server file may only take components and types from a `"use client"` file, never plain functions or constants. Put shared helpers in a plain module.
- **Before every push:** run `npx eslint src tests`, then `npx next typegen && NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit`, then `npx vitest run`.
