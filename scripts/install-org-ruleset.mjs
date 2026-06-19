import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORG = process.env.QUALITY_CONTROL_ORG || "wisent-ai";
const HOST_REPO = process.env.QUALITY_CONTROL_HOST_REPO || "quality-control";
const RULESET_NAME = process.env.QUALITY_CONTROL_RULESET_NAME || "Wisent quality control";
const WORKFLOW_PATH =
  process.env.QUALITY_CONTROL_WORKFLOW_PATH || ".github/workflows/required-pr-quality.yml";
const WORKFLOW_REF = process.env.QUALITY_CONTROL_WORKFLOW_REF || "main";

function runGh(args, options = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`gh ${args.join(" ")} failed\n${output}`);
  }

  return result.stdout.trim();
}

function getRepositoryId() {
  const json = runGh([
    "repo",
    "view",
    `${ORG}/${HOST_REPO}`,
    "--json",
    "databaseId",
  ]);
  return JSON.parse(json).databaseId;
}

function installRuleset(repositoryId) {
  const body = {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: {
        include: ["~DEFAULT_BRANCH"],
        exclude: [],
      },
      repository_name: {
        include: ["~ALL"],
        exclude: [HOST_REPO],
        protected: true,
      },
    },
    rules: [
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["merge", "squash", "rebase"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "workflows",
        parameters: {
          do_not_enforce_on_create: true,
          workflows: [
            {
              path: WORKFLOW_PATH,
              ref: WORKFLOW_REF,
              repository_id: repositoryId,
            },
          ],
        },
      },
    ],
  };

  const dir = mkdtempSync(join(tmpdir(), "wisent-quality-control-"));
  const bodyPath = join(dir, "ruleset.json");
  writeFileSync(bodyPath, `${JSON.stringify(body, null, 2)}\n`);

  try {
    return runGh([
      "api",
      "--method",
      "POST",
      "-H",
      "Accept: application/vnd.github+json",
      "-H",
      "X-GitHub-Api-Version: 2026-03-10",
      `/orgs/${ORG}/rulesets`,
      "--input",
      bodyPath,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  const repositoryId = getRepositoryId();
  const response = installRuleset(repositoryId);
  console.log(response);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
