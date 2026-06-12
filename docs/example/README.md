# Example review packet

Read a review packet before installing anything. These three artifacts are a
real, unedited `review-surfaces` run against a repository the tool had never
seen — [`sindresorhus/got`](https://github.com/sindresorhus/got) at commit
`a5b76bffb33d5fa8b0d1393cce410b88e7c2b848`, reviewing its last three commits
with no Acai spec and no config (the spec-less cold-start path).

- [`human_review.md`](human_review.md) — the markdown review surface: verdict,
  guided reading order, change map, semantic facts, trust audit.
- [`human_review.html`](human_review.html) — the self-contained HTML cockpit
  (download and open in a browser; it works offline from disk).
- [`comment.md`](comment.md) — the sticky PR comment the GitHub Action would
  post.

## Exactly how they were generated

```bash
git clone https://github.com/sindresorhus/got.git && cd got
git checkout a5b76bffb33d5fa8b0d1393cce410b88e7c2b848

review-surfaces all --provider mock --base 'HEAD~3' --head HEAD \
  --now 2026-06-12T00:00:00Z --out .review-surfaces
review-surfaces human --format html --out .review-surfaces
review-surfaces comment --format sticky --out .review-surfaces
```

`--provider mock` keeps the run fully offline and deterministic (no LLM is
consulted; every fact is computed). `--now` freezes the clock so re-running
the commands above reproduces these artifacts byte for byte. Secret redaction
runs before every render; `review-surfaces validate .review-surfaces
--surface all` passes on this output.
