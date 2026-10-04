import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

const CONVENTIONAL_PREFIX = /^[a-z]+(\([^)]+\))?!?:\s+(.+)$/i;
// The thresholds a subject is held to, each an action input the operator states (through
// repository or organisation variables); a threshold nobody stated is not applied, and the
// report names it as such.
const THRESHOLDS = Object.freeze({
  minInformativeWords: "MIN_INFORMATIVE_WORDS",
  minSubjectCharacters: "MIN_SUBJECT_CHARACTERS",
  minSubjectWords: "MIN_SUBJECT_WORDS",
  minWordCharacters: "MIN_WORD_CHARACTERS",
});
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

// A stated threshold is a positive whole number; an absent or empty one is `null`.
function statedThreshold(name, raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, received ${raw}`);
  }
  return value;
}

export function evaluateCommitMessage(message, options = {}) {
  const stated = Object.fromEntries(
    Object.keys(THRESHOLDS).map((name) => [name, statedThreshold(name, options[name])]),
  );
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

  if (stated.minSubjectCharacters !== null && subject.length < stated.minSubjectCharacters) {
    reasons.push(`subject is shorter than ${stated.minSubjectCharacters} characters`);
  }

  if (stated.minSubjectWords !== null && !hasConventionalPrefix && tokens.length < stated.minSubjectWords) {
    reasons.push(
      `subject has ${tokens.length} word(s); describing the changed object and action takes at least ${stated.minSubjectWords}`,
    );
  }

  if (stated.minInformativeWords !== null && uniqueTokens.size < stated.minInformativeWords) {
    reasons.push(
      `subject has ${uniqueTokens.size} distinct word(s); expected at least ${stated.minInformativeWords}`,
    );
  }

  if (stated.minWordCharacters !== null) {
    const longTokens = tokens.filter((token) => token.length >= stated.minWordCharacters);
    const hasSpecificMarker = /[._/-]/.test(scoringSubject);
    if (longTokens.length === 0 && !hasSpecificMarker) {
      reasons.push(
        `subject has no identifier and no word of ${stated.minWordCharacters} or more characters`,
      );
    }
  }

  return {
    ok: reasons.length === 0,
    skipped: false,
    subject,
    reasons,
    informativeTokens: [...uniqueTokens],
    unstated: Object.keys(THRESHOLDS).filter((name) => stated[name] === null),
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
  const options = Object.fromEntries(
    Object.entries(THRESHOLDS).map(([name, variable]) => [name, process.env[variable]]),
  );
  const unstated = Object.entries(THRESHOLDS)
    .filter(([name]) => statedThreshold(name, options[name]) === null)
    .map(([, variable]) => variable);
  if (unstated.length > 0) {
    console.log(`Not applied, because no value was stated: ${unstated.join(", ")}.`);
  }
  const failures = [];
  let skipped = 0;

  for (const commit of commits) {
    if (isMergeCommit(commit)) {
      skipped += 1;
      continue;
    }

    const result = evaluateCommitMessage(commit.message, options);
    if (!result.ok) {
      failures.push({ commit, result });
      console.log(
        `::error title=Uninformative commit message::${annotationEscape(
          `${commit.sha} "${result.subject}" - ${result.reasons.join("; ")}`,
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
