# Kaizen Ads

Creative requests → production → client approval → launch, for Kaizen Marketing's creative team, paid team and clients.
Live at **ads.kaizenmarketing.agency**.

- What we're building and why: [docs/VISION.md](docs/VISION.md)
- The build spec and phases: [PLAN.md](PLAN.md)
- Clickable mockups: [docs/mockups/](docs/mockups/)

## Stack

Next.js 16 · React 19 · Tailwind 4 · Supabase (Postgres, Auth, Storage) · Vercel · Resend. Same foundation and branding as Kaizen Track.

- **Team** signs in with Google (`@kaizenmarketing.agency`, invite-only: creating a profile on the Team page is the invite).
- **Clients** sign in with a magic link emailed by the app. Only emails added as client contacts can sign in.
- Access rules live in the database (RLS). See `supabase/migrations/` and the rule tests in `supabase/tests/`.

## Local development

```bash
cp .env.example .env.local   # then fill in SUPABASE_SECRET_KEY and RESEND_API_KEY
npm install
npm run dev
```

Checks (also run in CI): `npx eslint src tests`, `npx tsc --noEmit`, `npm test`, `npm run test:db` (needs `SUPABASE_DB_URL`).
