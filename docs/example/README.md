# Example review packet

Read the reviewer brief before installing anything. These artifacts are a real,
unedited `review-surfaces` PR-scoped run against a repository the tool
had never seen — [`sindresorhus/got`](https://github.com/sindresorhus/got) at commit
`a5b76bffb33d5fa8b0d1393cce410b88e7c2b848`, reviewing its last three commits
with no Acai spec and no config (the spec-less cold-start path).

- [`comment.md`](comment.md) — the adaptive reviewer brief the GitHub Action
  posts: verdict, author-grounded purpose, and every approval decision.
- [`human_review.md`](human_review.md) — the same compact brief plus links to
  complete supporting artifacts for readers who need to investigate further.
- [`human_review.html`](human_review.html) — the self-contained HTML cockpit
  (download and open in a browser; it works offline from disk).

The directory also includes the schema-validated [`human_review.json`](human_review.json)
and every focused artifact linked from the compact Markdown brief, so none of
its progressive-disclosure links are dead in this packaged example.

## Exactly how they were generated

```bash
git clone https://github.com/sindresorhus/got.git && cd got
git checkout a5b76bffb33d5fa8b0d1393cce410b88e7c2b848

review-surfaces all --provider mock --base 'HEAD~3' --head HEAD \
  --now 2026-06-12T00:00:00Z --out .review-surfaces \
  --review-scope pr \
  --change-title 'Harden abort handling and cross-origin pagination' \
  --change-description $'## Summary\n\nAttach abort listeners after request handlers run, strip inherited sensitive headers when pagination crosses origins, and document the behavior.\n\n## Validation\n\nAdd abort and pagination regression tests.'
review-surfaces human --review-scope pr --format html --out .review-surfaces
review-surfaces comment --review-scope pr --format sticky --out .review-surfaces
```

`--provider mock` keeps the run fully offline and deterministic (no LLM is
consulted; every fact is computed). `--now` freezes the clock so re-running
the commands above reproduces these artifacts byte for byte. Secret redaction
runs before every render; `review-surfaces validate .review-surfaces
--surface all` passes on this output.
