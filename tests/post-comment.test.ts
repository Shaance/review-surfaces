import test from "node:test";
import assert from "node:assert/strict";
import {
  CommandRunner,
  ownedStickyCommentId,
  parseStickyFingerprint,
  postStickyComment,
  readOwnedStickyComment,
  removeStickyComment
} from "../src/render/post-comment";

test("sticky lookup ignores later user-authored marker quotes and selects the posting account's exact marker", () => {
  const payload = [[
    {
      id: 101,
      user: { login: "github-actions[bot]" },
      body: "<!-- review-surfaces:sticky -->\n## review-surfaces\n"
    },
    {
      id: 102,
      user: { login: "reviewer" },
      body: "<!-- review-surfaces:sticky -->\nI copied the bot marker."
    },
    {
      id: 103,
      user: { login: "github-actions[bot]" },
      body: "A quoted <!-- review-surfaces:sticky --> marker is not a sticky."
    }
  ]];

  assert.equal(ownedStickyCommentId(payload, "github-actions[bot]"), "101");
});

test("sticky lookup returns the latest exact marker owned by the posting account", () => {
  const payload = [
    [{ id: 1, user: { login: "bot" }, body: "<!-- review-surfaces:sticky -->\nold" }],
    [{ id: 2, user: { login: "bot" }, body: "<!-- review-surfaces:sticky -->\nnew" }]
  ];

  assert.equal(ownedStickyCommentId(payload, "bot"), "2");
});

test("shared sticky reader uses explicit Actions context and parses only the final fingerprint", () => {
  const calls: string[][] = [];
  const body = [
    "<!-- review-surfaces:sticky -->",
    "## review-surfaces",
    "<!-- review-surfaces:fingerprint head=deadbeef run=123 queue=0123456789abcdef0123 -->"
  ].join("\n");
  const responses = [
    { status: 0, stdout: "gh version 2\n", stderr: "" },
    { status: 0, stdout: "github-actions[bot]\n", stderr: "" },
    { status: 0, stdout: "9\n", stderr: "" },
    { status: 0, stdout: JSON.stringify({ id: 9, user: { login: "github-actions[bot]" }, body }), stderr: "" }
  ];
  const run: CommandRunner = (command, args) => {
    calls.push([command, ...args]);
    return responses.shift() ?? { status: 1, stdout: "", stderr: "unexpected call" };
  };
  const previousRepo = process.env.GH_REPO;
  const previousNumber = process.env.GH_PR_NUMBER;
  process.env.GH_REPO = "Shaance/review-surfaces";
  process.env.GH_PR_NUMBER = "136";
  const result = readOwnedStickyComment("/repo", {}, run);
  if (previousRepo === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = previousRepo;
  if (previousNumber === undefined) delete process.env.GH_PR_NUMBER;
  else process.env.GH_PR_NUMBER = previousNumber;

  assert.equal(result.status, "found");
  assert.deepEqual(result.status === "found" ? result.fingerprint : undefined, { headSha: "deadbeef", runId: "123" });
  assert.equal(calls.some((call) => call[1] === "pr" && call[2] === "view"), false);
  const listCall = calls.find((call) => call[1] === "api" && call.includes("--paginate"));
  assert.ok(listCall);
  const jqIndex = listCall.indexOf("--jq");
  assert.notEqual(jqIndex, -1);
  const jq = listCall[jqIndex + 1];
  assert.match(jq, /github-actions\[bot\]/u);
  assert.match(jq, /review-surfaces:sticky/u);
  assert.match(jq, /last \/\/ empty/u);
  assert.equal(listCall.includes("--slurp"), false);
  assert.ok(calls.some((call) => call.some((arg) => arg.endsWith("/issues/comments/9"))));
  assert.deepEqual(parseStickyFingerprint(`${body}\nquoted text`), undefined);
});

test("Actions installation-token posting uses the documented bot when the user endpoint is unavailable", () => {
  const calls: string[][] = [];
  const responses = [
    { status: 0, stdout: "gh version 2\n", stderr: "" },
    { status: 0, stdout: "136\n", stderr: "" },
    { status: 0, stdout: "Shaance/review-surfaces\n", stderr: "" },
    { status: 1, stdout: "", stderr: "HTTP 403" },
    {
      status: 0,
      stdout: "77\n",
      stderr: ""
    },
    {
      status: 0,
      stdout: JSON.stringify({
        id: 77,
        user: { login: "github-actions[bot]" },
        body: "<!-- review-surfaces:sticky -->\nold"
      }),
      stderr: ""
    },
    { status: 0, stdout: "", stderr: "" }
  ];
  const run: CommandRunner = (command, args) => {
    calls.push([command, ...args]);
    return responses.shift() ?? { status: 1, stdout: "", stderr: "unexpected call" };
  };

  const previousGithubActions = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  const result = postStickyComment(
    "/repo",
    "<!-- review-surfaces:sticky -->\n## review-surfaces\n",
    {},
    run
  );
  if (previousGithubActions === undefined) delete process.env.GITHUB_ACTIONS;
  else process.env.GITHUB_ACTIONS = previousGithubActions;

  assert.equal(result.posted, true);
  assert.equal(calls.some((call) => call[1] === "api" && call[2] === "installation"), false);
  assert.ok(calls.some((call) => call.includes("PATCH") && call.some((arg) => arg.endsWith("/issues/comments/77"))));
});

test("sticky lookup failure never falls through to creating a duplicate comment", () => {
  const calls: string[][] = [];
  const responses = [
    { status: 0, stdout: "gh version 2\n", stderr: "" },
    { status: 0, stdout: "136\n", stderr: "" },
    { status: 0, stdout: "Shaance/review-surfaces\n", stderr: "" },
    { status: 0, stdout: "github-actions[bot]\n", stderr: "" },
    { status: 1, stdout: "", stderr: "temporary API failure" }
  ];
  const run: CommandRunner = (command, args) => {
    calls.push([command, ...args]);
    return responses.shift() ?? { status: 1, stdout: "", stderr: "unexpected call" };
  };

  const result = postStickyComment(
    "/repo",
    "<!-- review-surfaces:sticky -->\n## review-surfaces\n",
    {},
    run
  );

  assert.equal(result.posted, false);
  assert.match(result.reason, /avoid targeting the wrong comment/);
  assert.equal(calls.length, 5);
  assert.equal(calls.some((call) => (call[1] === "pr" && call[2] === "comment") || call.includes("PATCH")), false);
});

test("no-diff cleanup removes only the current exact-head owned sticky", () => {
  const calls: string[][] = [];
  const responses = [
    { status: 0, stdout: "gh version 2\n", stderr: "" },
    { status: 0, stdout: "136\n", stderr: "" },
    { status: 0, stdout: "Shaance/review-surfaces\n", stderr: "" },
    { status: 0, stdout: JSON.stringify({ head: { sha: "abc123" }, title: "Purpose", body: "" }), stderr: "" },
    { status: 0, stdout: "github-actions[bot]\n", stderr: "" },
    {
      status: 0,
      stdout: "55\n",
      stderr: ""
    },
    {
      status: 0,
      stdout: JSON.stringify({ id: 55, user: { login: "github-actions[bot]" }, body: "<!-- review-surfaces:sticky -->\nold" }),
      stderr: ""
    },
    { status: 0, stdout: "", stderr: "" }
  ];
  const run: CommandRunner = (command, args) => {
    calls.push([command, ...args]);
    return responses.shift() ?? { status: 1, stdout: "", stderr: "unexpected call" };
  };

  const result = removeStickyComment("/repo", { headSha: "abc123" }, run);

  assert.equal(result.removed, true);
  assert.ok(calls.some((call) => call.includes("DELETE") && call.some((arg) => arg.endsWith("/issues/comments/55"))));
});

test("no-diff cleanup cannot delete a newer head's sticky", () => {
  const calls: string[][] = [];
  const responses = [
    { status: 0, stdout: "gh version 2\n", stderr: "" },
    { status: 0, stdout: "136\n", stderr: "" },
    { status: 0, stdout: "Shaance/review-surfaces\n", stderr: "" },
    { status: 0, stdout: JSON.stringify({ head: { sha: "new-head" }, title: "Purpose", body: "" }), stderr: "" }
  ];
  const run: CommandRunner = (command, args) => {
    calls.push([command, ...args]);
    return responses.shift() ?? { status: 1, stdout: "", stderr: "unexpected call" };
  };

  const result = removeStickyComment("/repo", { headSha: "old-head" }, run);

  assert.equal(result.removed, false);
  assert.match(result.reason, /head changed/);
  assert.equal(calls.some((call) => call.includes("DELETE")), false);
});

test("posting rejects a same-head brief after the PR title or body changes", () => {
  const calls: string[][] = [];
  const responses = [
    { status: 0, stdout: "gh version 2\n", stderr: "" },
    { status: 0, stdout: "136\n", stderr: "" },
    { status: 0, stdout: "Shaance/review-surfaces\n", stderr: "" },
    {
      status: 0,
      stdout: JSON.stringify({ head: { sha: "abc123" }, title: "New purpose", body: "Updated after generation." }),
      stderr: ""
    }
  ];
  const run: CommandRunner = (command, args) => {
    calls.push([command, ...args]);
    return responses.shift() ?? { status: 1, stdout: "", stderr: "unexpected call" };
  };

  const result = postStickyComment(
    "/repo",
    "<!-- review-surfaces:sticky -->\n## review-surfaces\n",
    {
      headSha: "abc123",
      changeContext: {
        title: "Old purpose",
        description: "Original body.",
        source: "github",
        redaction_blocked: false
      }
    },
    run
  );

  assert.equal(result.posted, false);
  assert.match(result.reason, /title or description changed/);
  assert.equal(calls.some((call) => (call[1] === "pr" && call[2] === "comment") || call.includes("PATCH")), false);
});
