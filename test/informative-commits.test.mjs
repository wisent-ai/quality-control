import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCommitMessage } from "../.github/actions/informative-commits/check-informative-commits.mjs";

// The action's documented default: two informative words per subject.
const options = { minInformativeWords: 2 };

const accepted = [
  "Add Apple Ads credential connector",
  "fix: persist Google Ads account chooser",
  "docs: explain organization ruleset install path",
  "Improve Swiatowid transcript provider grouping",
  "refactor(api): isolate Meta token validation",
];

const rejected = [
  "",
  "fix",
  "update",
  "changes",
  "wip",
  "fix bug",
  "more changes",
  "update stuff",
  "test",
  "cleanup",
];

test("accepts specific commit subjects", () => {
  for (const message of accepted) {
    const result = evaluateCommitMessage(message, options);
    assert.equal(result.ok, true, `${message}: ${result.reasons.join(", ")}`);
  }
});

test("rejects vague commit subjects", () => {
  for (const message of rejected) {
    const result = evaluateCommitMessage(message, options);
    assert.equal(result.ok, false, `${message} should be rejected`);
  }
});

test("uses only the first line of a commit message", () => {
  const result = evaluateCommitMessage("fix\n\nDetailed body that should not rescue this.", options);
  assert.equal(result.ok, false);
});
