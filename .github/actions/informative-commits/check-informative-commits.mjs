import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CONVENTIONAL_PREFIX = /^[a-z]+(\([^)]+\))?!?:\s+(.+)$/i;
// A token of this length or more is a word rather than an article or abbreviation.
const LONG_TOKEN_LENGTH = 4;
const MIN_SUBJECT_LENGTH = 12;
// Object, action and one qualifier: the shortest subject that says what changed.
const MIN_SUBJECT_TOKENS = 3;
// GitHub's largest page for pull-request commits; a shorter page is the last one.
const COMMITS_PAGE_SIZE = 100;
// The `typeof` a commit field has to have to be read as text.
const TEXT_TYPE = "string";

function normalizeSubject(subject) {
  return subject
    .toLowerCase()
    .replace(/[`'"()[\]{}]/g, "")
    .replace(/[^a-z0-9._/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function subjectFromMessage(message) {
  if (typeof message !== TEXT_TYPE) {
    throw new Error(`commit message must be a string, received ${message === undefined ? "nothing" : typeof message}`);
  }
  return message
    .split(/\r?\n/, 1)[0]
    .trim();
}

function stripConventionalPrefix(subject) {
  const match = subject.match(CONVENTIONAL_PREFIX);
  return {
    hasConventionalPrefix: Boolean(match),
    scoringSubject: match ? match[2].trim() : subject,
  };
}

function tokenize(subject) {
  return normalizeSubject(subject)
    .split(" ")
    .filter(Boolean);
}

function isMergeCommit(commit) {
  if (Array.isArray(commit.parents) && commit.parents.length > 1) {
    return true;
  }

  const subject = subjectFromMessage(commit.message);
  return /^merge (branch|pull request)\b/i.test(subject);
}

export function evaluateCommitMessage(message, options = {}) {
  const minInformativeWords = Number(options.minInformativeWords);
  if (!Number.isInteger(minInformativeWords) || minInformativeWords < 1) {
    throw new Error(`minInformativeWords must be a positive integer, received ${options.minInformativeWords}`);
  }
  const subject = subjectFromMessage(message);
  const reasons = [];

  if (!subject) {
    return {
      ok: false,
      skipped: false,
      subject,
      reasons: ["commit subject is empty"],
    };
  }

  const { hasConventionalPrefix, scoringSubject } = stripConventionalPrefix(subject);
  const tokens = tokenize(scoringSubject);
  const uniqueTokens = new Set(tokens);
  const longTokens = tokens.filter((token) => token.length >= LONG_TOKEN_LENGTH);
  const hasSpecificMarker = /[._/-]/.test(scoringSubject);

  if (subject.length < MIN_SUBJECT_LENGTH) {
    reasons.push(`subject is shorter than ${MIN_SUBJECT_LENGTH} characters`);
  }

  if (!hasConventionalPrefix && tokens.length < MIN_SUBJECT_TOKENS) {
    reasons.push("subject should describe the changed object and action");
  }

  if (uniqueTokens.size < minInformativeWords) {
    reasons.push(
      `subject has ${uniqueTokens.size} distinct word(s); expected at least ${minInformativeWords}`,
    );
  }

  if (longTokens.length === 0 && !hasSpecificMarker) {
    reasons.push("subject lacks a specific identifier or descriptive word");
  }

  return {
    ok: reasons.length === 0,
    skipped: false,
    subject,
    reasons,
    informativeTokens: [...uniqueTokens],
  };
}

function annotationEscape(value) {
  return String(value)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

async function githubJson(path) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN is required");
  }

  const apiUrl = process.env.GITHUB_API_URL;
  if (!apiUrl) {
    throw new Error("GITHUB_API_URL is required; GitHub Actions sets it for every job");
  }
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${body}`);
  }

  return response.json();
}

async function collectPullRequestCommits(owner, repo, pullNumber) {
  const commits = [];

  for (let page = 1; ; page += 1) {
    const batch = await githubJson(
      `/repos/${owner}/${repo}/pulls/${pullNumber}/commits?per_page=${COMMITS_PAGE_SIZE}&page=${page}`,
    );
    commits.push(...batch);
    if (batch.length < COMMITS_PAGE_SIZE) {
      return commits.map(pullRequestCommit);
    }
  }
}

function pullRequestCommit(commit) {
  if (typeof commit.sha !== TEXT_TYPE || typeof commit.commit?.message !== TEXT_TYPE) {
    throw new Error(`GitHub returned a commit without sha or message: ${JSON.stringify(commit)}`);
  }
  return {
    sha: commit.sha,
    message: commit.commit.message,
    parents: commit.parents,
  };
}

async function collectCompareCommits(owner, repo, baseSha, headSha) {
  const compare = await githubJson(`/repos/${owner}/${repo}/compare/${baseSha}...${headSha}`);
  if (!Array.isArray(compare.commits)) {
    throw new Error(`GitHub compare ${baseSha}...${headSha} returned no commits array`);
  }
  return compare.commits.map(pullRequestCommit);
}

function collectPushCommits(event) {
  return event.commits.map((commit) => {
    if (typeof commit.id !== TEXT_TYPE || typeof commit.message !== TEXT_TYPE) {
      throw new Error(`push event carries a commit without id or message: ${JSON.stringify(commit)}`);
    }
    return {
      sha: commit.id,
      message: commit.message,
      parents: commit.parents,
    };
  });
}

async function collectCommitsFromEvent(event) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !repository.includes("/")) {
    throw new Error("GITHUB_REPOSITORY is required and must be owner/name");
  }

  const [owner, repo] = repository.split("/");

  if (event.pull_request?.number) {
    return collectPullRequestCommits(owner, repo, event.pull_request.number);
  }

  if (event.merge_group?.base_sha && event.merge_group?.head_sha) {
    return collectCompareCommits(owner, repo, event.merge_group.base_sha, event.merge_group.head_sha);
  }

  if (Array.isArray(event.commits)) {
    return collectPushCommits(event);
  }

  throw new Error("Unsupported GitHub event payload; expected pull_request, merge_group, or push");
}

export async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is required");
  }

  const event = JSON.parse(await fs.readFile(eventPath, "utf8"));
  const commits = await collectCommitsFromEvent(event);
  if (!process.env.MIN_INFORMATIVE_WORDS) {
    throw new Error("MIN_INFORMATIVE_WORDS is required; the action input min-informative-words sets it");
  }
  const minInformativeWords = Number(process.env.MIN_INFORMATIVE_WORDS);
  const failures = [];
  let skipped = 0;

  for (const commit of commits) {
    if (isMergeCommit(commit)) {
      skipped += 1;
      continue;
    }

    const result = evaluateCommitMessage(commit.message, { minInformativeWords });
    if (!result.ok) {
      failures.push({ commit, result });
      const sha = commit.sha.slice(0, 12);
      console.log(
        `::error title=Uninformative commit message::${annotationEscape(
          `${sha} "${result.subject}" - ${result.reasons.join("; ")}`,
        )}`,
      );
    }
  }

  const checked = commits.length - skipped;
  if (failures.length > 0) {
    console.error(
      `Quality control failed: ${failures.length}/${checked} checked commit message(s) are not informative.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Quality control passed: ${checked} commit message(s) checked, ${skipped} merge commit(s) skipped.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
