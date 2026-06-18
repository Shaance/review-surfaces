# review-surfaces effectiveness scorecard

Cases run: **22/22** (mock provider, full `all` pipeline over pinned real diffs).

| Metric | Result | Target |
|---|---|---|
| empty-queue rate (substantive diffs) | 0% (0/22) | 0% |
| false-blocker rate (spec-less) | 0% (0/22) | 0% |
| top item is code/impl | 91% (20/22) | high |
| irrelevant (doc/generated/lock/binary) in top-5 | 0% (0/22) | 0% |
| focus recall@5 (annotated) | 100% | high |

## Per-case

| id | lang | queue | blockers | top item | top role | empty? | false-blocker? | recall@5 |
|---|---|---|---|---|---|---|---|---|
| ky-network-error | ts | 2 | 0 | `source/utils/is-network-error.ts` | code | no | no | 100% |
| ky-core | ts | 3 | 0 | `source/core/Ky.ts` | code | no | no | 100% |
| express-response | js | 2 | 0 | `lib/response.js` | code | no | no | 100% |
| express-send | js | 2 | 0 | `package.json` | other | no | no | 100% |
| cobra-args | go | 2 | 0 | `args.go` | code | no | no | 100% |
| cobra-yaml-docs | go | 2 | 0 | `doc/yaml_docs.go` | code | no | no | 100% |
| gin-version | go | 1 | 0 | `version.go` | code | no | no | 100% |
| gin-debug | go | 3 | 0 | `debug.go` | code | no | no | 100% |
| flask-cli | py | 2 | 0 | `src/flask/cli.py` | code | no | no | 100% |
| flask-app | py | 1 | 0 | `src/flask/sansio/app.py` | code | no | no | 100% |
| requests-models | py | 3 | 0 | `src/requests/models.py` | code | no | no | 100% |
| requests-broad | py | 8 | 0 | `src/requests/sessions.py` | code | no | no | — |
| click-termui | py | 3 | 0 | `src/click/_termui_impl.py` | code | no | no | 100% |
| ripgrep-flags | rust | 1 | 0 | `crates/core/flags/defs.rs` | code | no | no | 100% |
| ripgrep-ignore | rust | 1 | 0 | `crates/ignore/src/dir.rs` | code | no | no | 100% |
| clap-lib | rust | 4 | 0 | `src/lib.rs` | code | no | no | 100% |
| clap-mangen | rust | 4 | 0 | `clap_mangen/src/render.rs` | code | no | no | 100% |
| gson-jsonreader | java | 2 | 0 | `gson/src/test/java/com/google/gson/stream/JsonReaderTest.java` | test | no | no | 100% |
| gson-proto | java | 7 | 0 | `proto/src/main/java/com/google/gson/protobuf/LegacyProtoTypeAdapterFactory.java` | code | no | no | 100% |
| gson-graph | java | 3 | 0 | `extras/src/main/java/com/google/gson/graph/GraphAdapterBuilder.java` | code | no | no | 100% |
| okhttp-interceptor | kotlin | 7 | 0 | `okhttp/src/commonJvmAndroid/kotlin/okhttp3/internal/http/RealInterceptorChain.kt` | code | no | no | 100% |
| sinatra-version | ruby | 4 | 0 | `lib/sinatra/version.rb` | code | no | no | 100% |

