# review-surfaces effectiveness scorecard

Cases run: **6/6** (mock provider, full `all` pipeline over pinned real diffs).

| Metric | Result | Target |
|---|---|---|
| empty-queue rate (substantive diffs) | 0% (0/6) | 0% |
| false-blocker rate (spec-less) | 0% (0/6) | 0% |
| top item is code/impl | 83% (5/6) | high |
| irrelevant (doc/generated) in top-5 | 0% (0/6) | 0% |
| focus recall@5 (annotated) | 100% | high |

## Per-case

| id | lang | queue | blockers | top item | top role | empty? | false-blocker? | recall@5 |
|---|---|---|---|---|---|---|---|---|
| ky-network-error | ts | 2 | 0 | `source/utils/is-network-error.ts` | code | no | no | 100% |
| cobra-args | go | 2 | 0 | `args.go` | code | no | no | 100% |
| flask-cli | py | 2 | 0 | `src/flask/cli.py` | code | no | no | 100% |
| requests-models | py | 3 | 0 | `src/requests/models.py` | code | no | no | 100% |
| ripgrep-flags | rust | 1 | 0 | `crates/core/flags/defs.rs` | code | no | no | 100% |
| gson-jsonreader | java | 2 | 0 | `gson/src/test/java/com/google/gson/stream/JsonReaderTest.java` | test | no | no | 100% |

