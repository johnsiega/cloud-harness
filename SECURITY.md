# Security

Cloud harness runs AI-written code on an AWS account you own, spends your money, and can hold a GitHub token. Please treat it that way.

## Reporting a vulnerability

Please **don't** open a public issue for a security problem. Use GitHub's private reporting instead: the **Security** tab, then **Report a vulnerability**. Include what you found, how to reproduce it, and what it could let an attacker do.

Never include real keys, tokens or account IDs in a report.

## What is in scope

- Anything that lets a web page, another local program, or another machine start runs, read run data, or push branches without the owner's say-so.
- Anything that leaks the OpenRouter key or the GitHub token into logs, responses, the browser, the sandbox image, or git history.
- Anything that lets a push write outside a new `harness/<run id>` branch, overwrite a branch, or run git with the wrong credentials or protocols.

## What it already does

See "Safety choices" in the [README](README.md). In short: loopback-only with Host and Origin checks, secret redaction before anything is stored or streamed, the push and PR tokens kept out of the sandbox and out of command lines, one non-forced push per run, and draft-only pull requests into an allowlist of repos.

## What it does not do

- It is a prototype with no authentication or multi-user separation. Run it only on a machine you trust.
- The sandbox has open internet access, and the agent can run anything inside it.
- It does not decide whether an AI-written change is good. Read the diff.
- Use scoped credentials: an IAM user limited to MicroVM actions, an OpenRouter key with a spending limit, and GitHub tokens limited to the specific repositories they need (the push token to one private repo; the optional PR token only to the repos listed in `PR_REPOS`) with a short expiry.
