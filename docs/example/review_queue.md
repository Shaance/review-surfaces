# Review Queue

Generated from `review_packet.json` and `pr_review_surface.json`.

## Untested implementation change — `source/core/index.ts` (REVIEW-001)

Priority: medium
Confidence: medium
File: `source/core/index.ts`


Why this matters:
2 changed implementation files share one validation question: focused changed-test evidence is connected to 1, 1 still lack connected changed-test evidence, and no current-head transcript proves the relevant checks ran.

Why ranked here:
a focused test changed alongside this file (`test/abort.ts`), so it ranks lower among equal-severity items

Reviewer action:
Confirm the changed tests cover the connected behavior, add focused coverage only for the remaining gap, and record one current-head transcript.

```diff
@@ -297,7 +297,7 @@
     private _triggerRead = false;
     private readonly _jobs: Array<() => void> = [];
     private _cancelTimeouts?: () => void;
-    private readonly _abortListenerDisposer?: {[Symbol.dispose](): void};
+    private _abortListenerDisposer?: {[Symbol.dispose](): void};
     private _flushed = false;
     private _aborted = false;
     private _expectedContentLength?: number;
```
Evidence:
- `source/core/index.ts`
- `source/core/options.ts`
- `No current-head transcript establishes validation for the complete cited implementation group.`
- `test/abort.ts`

Risks: `PR-RISK-001`

---

## Unmapped changed file — `documentation/4-pagination.md` (REVIEW-002)

Priority: low
Confidence: medium
File: `documentation/4-pagination.md`


Why this matters:
2 changed file(s) did not map to any review area.

Reviewer action:
Confirm the unmapped change is intended and not missing a review-area mapping.

```diff
@@ -132,6 +132,7 @@
 **Note:**
 > - The `url` option (if set) accepts **only** a [`URL`](https://developer.mozilla.org/en-US/docs/Web/API/URL) instance.\
 >   This prevents `prefixUrl` ambiguity. In order to use a relative URL string, merge it via `new URL(relativeUrl, response.url)`.
+> - When pagination navigates to a different origin, Got strips inherited sensitive headers such as `authorization`, `cookie`, and `proxy-authorization`. If you trust the next-page URL and want to fo…
 
 #### `filter`
 
```
Evidence:
- `documentation/4-pagination.md`
- `package.json`

Risks: `PR-RISK-002`

---

## Review-focus: source/core/options.ts — `source/core/options.ts:796-797` (REVIEW-003)

Priority: medium
Confidence: high
File: `source/core/options.ts:796-797`


Why this matters:
Another finding was queued for this diff, and this changed source is also worth reading: an implementation change with no connected test change, touches error/async/auth/network/persistence paths.

Why ranked here:
no changed test or current-head transcript covers this file, so it ranks higher among equal-severity items

Reviewer action:
No defect pattern fired here — read this changed file to confirm the change is intended and skim-safe.

````diff
@@ -793,6 +793,8 @@
 
     It should return an object representing Got options pointing to the next page. The options are merged automatically with the previous request, therefore the options returned `pagination.paginate(...…
 
+    When pagination navigates to a different origin, Got strips inherited sensitive headers such as `authorization`, `cookie`, and `proxy-authorization`. If you trust the next-page URL and want to forwa…
+
     @example
     ```
     import got from 'got';
````
Evidence:
- `source/core/options.ts`
