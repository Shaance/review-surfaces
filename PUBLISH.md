# Publishing `review-surfaces` 0.2.0

This is the **owner's manual release runbook**. Everything except the steps that
require npm/GitHub credentials has already been done and verified (see
[Pre-publish verification](#pre-publish-verification-already-run)). The package
manifest already carries `0.2.0`, and `prepublishOnly` runs the full local gate,
so a publish physically cannot ship a red gate.

## 0. Prerequisites (one-time)

- An npm account that is a maintainer of (or first publisher of) the unclaimed
  name `review-surfaces`, logged in locally: `npm whoami` should print your user.
  If not: `npm login` (or set `NPM_TOKEN` and use an `.npmrc` with
  `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` — never commit the token).
- `gh` authenticated for the GitHub release (`gh auth status`).
- On a clean `main` at the commit you intend to ship:
  ```bash
  git checkout main && git pull --ff-only
  git status --porcelain   # must be empty
  node -e "console.log(require('./package.json').version)"   # must print 0.2.0
  ```

## 1. Stamp the changelog (one small commit)

In `CHANGELOG.md`, change the heading
`## 0.2.0 — unreleased (intended first npm publish)` to
`## 0.2.0 — <today's date>`, then commit on `main` (or via a tiny PR):
```bash
git add CHANGELOG.md && git commit -m "release: stamp 0.2.0 changelog date"
git push
```

## 2. Publish to npm

`prepublishOnly` runs `pnpm run local-gate` (lint, typecheck, full test,
determinism-check, pack smoke, strict empty-diff self-dogfood) and `prepack`
builds, so this is the whole publish:
```bash
npm publish
```
Use `npm publish --dry-run` first if you want to see the exact tarball file list
without shipping. The tarball ships only `bin/`, `dist/src/`, `schemas/`,
`docs/example/`, `CHANGELOG.md`, `LICENSE`, `README.md` (the `files` allowlist).

## 3. Tag and create the GitHub release

```bash
git tag -a v0.2.0 -m "review-surfaces 0.2.0 — first npm release"
git push origin v0.2.0
gh release create v0.2.0 \
  --title "review-surfaces 0.2.0" \
  --notes-file <(awk '/^## 0.2.0/{f=1;next} /^## 0.1/{f=0} f' CHANGELOG.md)
```

## 4. Post-publish verification (from npm, outside any checkout)

```bash
cd "$(mktemp -d)"
npx review-surfaces@0.2.0 --version          # -> review-surfaces 0.2.0
git clone --depth 30 https://github.com/sindresorhus/ky.git && cd ky
npx review-surfaces@0.2.0 all --base HEAD~1 --head HEAD --out /tmp/verify-out
open /tmp/verify-out/human_review.html        # cockpit renders
```
Confirm `--version` reports `0.2.0` (from the registry, not a local checkout) and
that `all` exits 0 and writes a cockpit.

## Pre-publish verification (already run)

On `release-prep-0.2.0` (this branch), against the freshly built `0.2.0` tarball:

| Check | Result |
|---|---|
| `npm pack` tarball size | **440 KB** (bin, dist/src ×106, schemas ×4, docs/example, CHANGELOG, LICENSE, README) |
| Clean `npm install <tarball>` **outside** the repo | **1.45 s**, exit 0 |
| `review-surfaces --version` (installed, outside repo) | `review-surfaces 0.2.0` |
| External TS repo (`sindresorhus/ky`, `HEAD~1..HEAD`: source fix + 33 test lines) | run **1.77 s**, artifacts **192 KB**, exit 0 |
| External Go repo (`spf13/cobra`, `HEAD~3..HEAD`: source + 55 test lines + docs) | run **0.61 s**, artifacts **196 KB**, exit 0 |

**Known limitation (tracked, next PR):** on both external (spec-less) repos the
review queue was **empty (0 review-first items)** despite substantive diffs — the
tool produced a verdict and asked for command evidence but did not rank
files-worth-reading. This is the cold-start value floor; a deterministic baseline
review-focus queue is the next planned change. It does NOT affect correctness of
what the tool *does* emit, and `prepublishOnly` still gates every publish.
