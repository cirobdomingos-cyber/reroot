# Release process

How a change gets from an idea to the people using auê. The goal is simple:
**nothing reaches a customer that hasn't run on staging first.**

## Environments

| Env | Branch | Who uses it | Data |
|---|---|---|---|
| Production | `main` | everyone (web + iPhone app) | production volume |
| Staging | `dev` | us, for testing | its own volume — safe to break |

- Production: https://reroot-production.up.railway.app (and auecuritiba.com)
- Staging: https://aue-staging.up.railway.app

Known-good production points are tagged `prod-YYYY-MM-DD`. The first one,
`prod-2026-09-15`, is the baseline this process started from.

## The flow

```
feat/<name>  ──PR──▶  dev (staging)  ──release PR──▶  main (production)  ──▶  iPhone canary  ──▶  everyone
   │                    │                               │                        │
   CI must pass         test on staging URL             verify deploy            your phone first
```

### 1. Build on a branch
- Branch from `dev`: `git switch dev && git pull && git switch -c feat/<name>`.
- One feature per branch. Commit as you go.

### 2. Pull request into `dev`
- `gh pr create --base dev` and fill in the template.
- **CI** (`.github/workflows/ci.yml`) runs three checks:
  - `backend` — pytest
  - `frontend` — lint (errors fail) + production build
  - `smoke` — Playwright opens every main screen at phone (390px), tablet
    (820px) and PC (1440px) width with the backend unreachable. Fails on a
    crash, the wrong navigation for the layout, or content wider than the
    screen. Screenshots are attached to the run as `smoke-report`.
- Merge when green. Railway deploys staging.

### 3. Test on staging
Open https://aue-staging.up.railway.app and
go through the pull request's checklist on:
- a PC browser,
- your phone's browser, logged in.

Staging has its own data, so create test groups/events freely.

### 4. Release pull request `dev` → `main`
- `gh pr create --base main --head dev --title "release: <what>"`
- Same CI runs. `main` is protected: no direct pushes, CI must be green.
- Merge. Railway deploys production.
- Tag it: `git tag -a prod-YYYY-MM-DD -m "<what>" && git push origin prod-YYYY-MM-DD`.

### 5. Verify production
- The served `index-*.js` changed and contains a marker unique to the change.
- `/updates/status` `main_chunk` matches the served chunk **before** any OTA step.

### 6. iPhone: canary, then everyone
Live updates ship the production web build to installed apps. Versions are
immutable on the device, so never set a version before step 5 passes.

1. Find your device id: Perfil → the bundle line at the bottom → tap to copy.
2. On Railway (production) set
   `OTA_CANARY_DEVICES=<your id>` (comma-separated for more testers) and
   `OTA_CANARY_VERSION=<next version>`.
   Only listed devices are offered it; everyone else is offered nothing
   until promotion.
3. Close and reopen the app twice on your phone; test.
4. **Promote:** set `OTA_BUNDLE_VERSION=<same version>` and delete
   `OTA_CANARY_VERSION`. **Abort:** just delete `OTA_CANARY_VERSION`.

## Urgent fixes (hotfix)
Production is broken and can't wait for the staging cycle:
- Branch from `main`: `git switch -c fix/<name> origin/main`
- `gh pr create --base main` — CI still has to pass.
- After merge, the sync bot merges `main` into `dev` automatically.

## Rolling back
- **Web/backend:** `git revert <merge commit>` on a branch, PR into `main`.
  Fastest: Railway → Deployments → redeploy the previous deployment, then
  revert in git so the next deploy doesn't bring it back.
- **iPhone:** a published version can't be pulled back from devices. Roll the
  web back first, then publish it under a **new** version number.

## Rules of thumb
- Two sessions or people working at once: separate branches, never the same
  screen in parallel.
- Anything user-visible gets a checklist item in its pull request.
- Behaviour that differs by environment comes from `ENV_NAME`, never from
  code that exists on only one branch.
