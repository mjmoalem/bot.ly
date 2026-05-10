import Fastify from "fastify";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";
import Anthropic from "@anthropic-ai/sdk";
import "dotenv/config";

const fastify = Fastify({ logger: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Webhook signature verification ───────────────────────────────────────────
function verifySignature(payload, signature, secret) {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(payload);
  const digest = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// ─── Get an installation-scoped Octokit ───────────────────────────────────────
function getInstallationOctokit(installationId) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: process.env.GITHUB_APP_ID,
      privateKey: process.env.GITHUB_PRIVATE_KEY.replace(/\\n/g, "\n"),
      installationId,
    },
  });
}

// ─── Fetch the diff for a pull request ────────────────────────────────────────
async function getPRDiff(octokit, owner, repo, pull_number) {
  const { data } = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  return data;
}

// ─── Fetch PR files with patch hunks ──────────────────────────────────────────
async function getPRFiles(octokit, owner, repo, pull_number) {
  const { data } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number,
    per_page: 50,
  });
  return data;
}

// ─── Build the review prompt ──────────────────────────────────────────────────
function buildReviewPrompt(pr, files) {
  const filesSummary = files
    .filter((f) => f.patch) // only files with actual diff hunks
    .slice(0, 20) // cap at 20 files to stay within context
    .map(
      (f) => `
### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})
\`\`\`diff
${f.patch}
\`\`\`
`
    )
    .join("\n");

  return `You are ReviewBot, an expert AI code reviewer. Review this pull request and provide actionable feedback.

## PR Context
- **Title**: ${pr.title}
- **Description**: ${pr.body || "(no description provided)"}
- **Author**: ${pr.user.login}
- **Base branch**: ${pr.base.ref} ← ${pr.head.ref}
- **Changed files**: ${pr.changed_files}, +${pr.additions}/-${pr.deletions} lines

## Changed Files
${filesSummary}

## Your Review Instructions
Focus on:
1. **Security** – injection, secrets, auth bypasses, IDOR, XSS, SSRF
2. **Correctness** – logic bugs, off-by-one errors, unhandled edge cases, null dereferences
3. **Performance** – N+1 queries, inefficient loops, missing indexes, memory leaks
4. **Code quality** – readability, naming, duplication, SOLID violations
5. **Testing gaps** – missing tests for changed behaviour

Respond in this EXACT JSON format (no markdown fences, raw JSON only):
{
  "summary": "2-3 sentence overall assessment",
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "issues": [
    {
      "severity": "critical" | "major" | "minor" | "nit",
      "file": "path/to/file.js",
      "line": 42,
      "title": "Short issue title",
      "description": "Detailed explanation and suggested fix"
    }
  ],
  "praise": ["one thing done really well", "another positive"],
  "score": 85
}

Be concise and precise. Only flag real issues. Do not invent problems.`;
}

// ─── Post inline comments + summary review ────────────────────────────────────
async function postReview(octokit, owner, repo, pull_number, headSha, review) {
  // Build inline comments for issues that have file+line
  const comments = review.issues
    .filter((i) => i.file && i.line)
    .map((i) => ({
      path: i.file,
      line: i.line,
      body: `**[${i.severity.toUpperCase()}] ${i.title}**\n\n${i.description}`,
    }));

  const severityEmoji = {
    critical: "🔴",
    major: "🟠",
    minor: "🟡",
    nit: "⚪",
  };

  const issuesList =
    review.issues.length === 0
      ? "_No issues found._"
      : review.issues
          .map(
            (i) =>
              `- ${severityEmoji[i.severity] || "•"} **${i.title}** (\`${i.file}:${i.line}\`) – ${i.description}`
          )
          .join("\n");

  const praiseList =
    review.praise?.map((p) => `- ✅ ${p}`).join("\n") || "";

  const body = `## 🤖 ReviewBot Analysis

${review.summary}

**Score: ${review.score}/100**

---

### Issues
${issuesList}

${praiseList ? `### What's Good\n${praiseList}` : ""}

---
<sub>Powered by ReviewBot · [Dashboard](${process.env.DASHBOARD_URL || "https://reviewbot.dev/dashboard"}) · [Docs](${process.env.DOCS_URL || "https://reviewbot.dev/docs"})</sub>`;

  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number,
    commit_id: headSha,
    body,
    event: review.verdict === "APPROVE" ? "APPROVE" : review.verdict === "REQUEST_CHANGES" ? "REQUEST_CHANGES" : "COMMENT",
    comments: comments.slice(0, 10), // GitHub caps inline comments per review
  });
}

// ─── Core review handler ───────────────────────────────────────────────────────
async function handlePullRequest(payload) {
  const { action, pull_request: pr, repository, installation } = payload;

  // Only review when a PR is opened, synchronized (new commits), or reopened
  if (!["opened", "synchronize", "reopened"].includes(action)) return;

  const owner = repository.owner.login;
  const repo = repository.name;
  const pull_number = pr.number;
  const headSha = pr.head.sha;

  fastify.log.info(`Reviewing PR #${pull_number} in ${owner}/${repo}`);

  const octokit = getInstallationOctokit(installation.id);

  // Post a "pending" status to let users know review is in progress
  await octokit.repos.createCommitStatus({
    owner,
    repo,
    sha: headSha,
    state: "pending",
    context: "reviewbot/ai-review",
    description: "AI review in progress…",
  });

  try {
    const files = await getPRFiles(octokit, owner, repo, pull_number);
    const prompt = buildReviewPrompt(pr, files);

    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const rawText = message.content[0].text.trim();
    const review = JSON.parse(rawText);

    await postReview(octokit, owner, repo, pull_number, headSha, review);

    const hasCritical = review.issues.some((i) => i.severity === "critical");
    await octokit.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      state: hasCritical ? "failure" : "success",
      context: "reviewbot/ai-review",
      description: hasCritical
        ? `⚠️ ${review.issues.filter((i) => i.severity === "critical").length} critical issue(s) found`
        : `✅ Score ${review.score}/100 – ${review.issues.length} issue(s)`,
    });
  } catch (err) {
    fastify.log.error(err);
    await octokit.repos.createCommitStatus({
      owner,
      repo,
      sha: headSha,
      state: "error",
      context: "reviewbot/ai-review",
      description: "ReviewBot encountered an error",
    });
  }
}

// ─── Webhook route ─────────────────────────────────────────────────────────────
fastify.post("/webhook", async (req, reply) => {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return reply.status(400).send("Missing signature");

  const rawBody = JSON.stringify(req.body);
  const valid = verifySignature(rawBody, signature, process.env.WEBHOOK_SECRET);
  if (!valid) return reply.status(401).send("Invalid signature");

  const event = req.headers["x-github-event"];
  fastify.log.info(`Received event: ${event}`);

  if (event === "pull_request") {
    // Fire-and-forget; respond 200 immediately so GitHub doesn't timeout
    handlePullRequest(req.body).catch((e) => fastify.log.error(e));
  }

  return reply.status(200).send({ ok: true });
});

// ─── Health check ──────────────────────────────────────────────────────────────
fastify.get("/health", async () => ({ status: "ok", version: "1.0.0" }));

// ─── Start ─────────────────────────────────────────────────────────────────────
try {
  await fastify.listen({ port: process.env.PORT || 3000, host: "0.0.0.0" });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
