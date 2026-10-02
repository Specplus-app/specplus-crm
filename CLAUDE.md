# SpecPlus CRM — Claude Development Rules

## Source of truth
- GitHub repository Specplus-app/specplus-crm is the production source of truth.
- `main` represents production code.
- Do not treat the old Bolt project as authoritative production source code.
- Production deploys through Vercel.

## Git safety
- Never modify `main` directly.
- Before product work, start from an up-to-date clean `main` and create a feature/fix/chore branch.
- Never commit, push, merge, open a pull request, or deploy unless explicitly instructed.
- Never force-push or rewrite shared history.
- Before any commit, report the files changed and the relevant git diff.
- Production changes should reach `main` through a reviewed pull request.

## Supabase / production safety
- Production Supabase project ref is `brzgvpissnewfkhblpvs`.
- The repository `.env` may contain old Bolt-era Supabase values. Do NOT assume `.env` identifies the production backend and do not change environment configuration without explicit approval.
- Never execute migrations against production, change RLS policies, deploy Edge Functions, modify Storage policies/buckets, alter Auth settings, or change any external service unless explicitly instructed.
- For schema changes, add a new timestamped migration. Do not edit historical migrations that have already shipped.
- Preserve existing tenant/shop isolation and RLS behavior unless a task explicitly requires a reviewed change.
- The valid application roles are `admin` and `shop_user`. Do not introduce or assume an `owner` role.
- Do not restore profile self-update permissions that could allow users to change their own role or shop_id.

## Existing behavior to preserve
- Public shop quote URLs use `/:shopSlug`.
- Legacy `/customize/:shopId` remains supported.
- Public customizer submissions create leads.
- Vehicle template cloning must preserve all supported vehicle-part fields, including `external_url` and `alt_view_svg_path`.
- Preserve the safe BuildSheet null check for box points.
- Preserve existing billing/trial read-only behavior unless explicitly changing it.

## Build and generated files
- On this Windows machine, use `npm.cmd` rather than `npm` when necessary because PowerShell blocks npm.ps1.
- Run the production build before presenting code as complete:
  `npm.cmd run build`
- `dist/` and `tsconfig.tsbuildinfo` are tracked/generated and may change during a build. Do not commit generated build changes unless explicitly requested.
- Restore generated-only changes after validation and finish with a clean working tree except for intentional source changes.

## Working style
- Inspect existing implementation before changing it.
- Prefer the smallest change that solves the requested problem.
- Do not make unrelated cleanup or dependency upgrades during feature work.
- Do not run automatic vulnerability fixes such as `npm audit fix` unless explicitly approved.
- Clearly distinguish code changes from production/backend actions.
- When finished, report:
  1. what changed,
  2. files changed,
  3. build/test result,
  4. git status,
  5. anything that still requires manual production action.
