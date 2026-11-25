#!/bin/bash
# Runs inside the MicroVM. stdout is JSONL events + the diff block; everything else goes to stderr.
# Env: REPO_URL TASK OPENROUTER_API_KEY MODEL [WORKDIR] [TEST_CMD: a command, or "skip"; unset = auto-detect] [TEST_INSTALL_TIMEOUT: seconds, default 180]
set +e  # a failing test or codex run must not abort before its exit code is captured
export GIT_TERMINAL_PROMPT=0

WORKDIR="${WORKDIR:-/workspace}"
RUNNER_DIR="$(cd "$(dirname "$0")" && pwd)"  # detect-tests.mjs ships next to this script (/opt/runner in the image)
MODEL="${MODEL:-deepseek/deepseek-v4.1-flash}"
PATCH="$(mktemp)"
# A fresh clone has no .env, so Laravel's ExampleTest dies with MissingAppKeyException. Generate a throwaway key (32 random bytes).
export APP_KEY="${APP_KEY:-base64:$(head -c 32 /dev/urandom | base64)}"

now() { date +%s%3N; }
emit() { printf '{"type":"%s","ts":%s,"exitCode":%s}\n' "$1" "$(now)" "$2"; }

git clone -q -- "$REPO_URL" "$WORKDIR" >&2
CLONE_EXIT=$?
if [ "$CLONE_EXIT" -ne 0 ] || ! cd "$WORKDIR"; then
  emit clone_exit "${CLONE_EXIT:-1}"
  echo "__DIFF_START__"; echo "__DIFF_END__"
  exit 1
fi

# The control plane applies the patch to a fresh clone at exactly this commit, so report it before codex can move HEAD.
printf '{"type":"base_commit","sha":"%s"}\n' "$(git rev-parse HEAD)"

# TASK is a single argv element after `--`: never spliced into a shell string.
codex exec \
  -c sandbox_mode=workspace-write \
  -c approval_policy=never \
  -c model_provider='"openrouter"' \
  -c model_providers.openrouter.name='"OpenRouter"' \
  -c model_providers.openrouter.base_url='"https://openrouter.ai/api/v1"' \
  -c model_providers.openrouter.env_key='"OPENROUTER_API_KEY"' \
  -c model_providers.openrouter.wire_api='"responses"' \
  -c model="\"$MODEL\"" \
  --json --skip-git-repo-check \
  -- "$TASK"
CODEX_EXIT=$?
emit codex_exit "$CODEX_EXIT"

# Snapshot the patch now, so dependency installs and test caches never end up in it.
# --binary keeps binary files in the patch (a plain diff says "Binary files differ" and drops the bytes).
git add -A && git diff --cached --binary > "$PATCH"

# Test step. An explicit TEST_CMD wins; otherwise detect-tests.mjs prints install, test and skip reason (one per line).
TEST_INSTALL=""; TEST_RUN=""; TEST_SKIP=""
if [ "$TEST_CMD" = "skip" ]; then TEST_SKIP="skipped by request"
elif [ -n "$TEST_CMD" ]; then TEST_RUN="$TEST_CMD"
elif PLAN="$(node "$RUNNER_DIR/detect-tests.mjs" .)"; then { read -r TEST_INSTALL; read -r TEST_RUN; read -r TEST_SKIP; } <<< "$PLAN"
fi
[ -n "$TEST_RUN$TEST_SKIP" ] || TEST_SKIP="detection failed"
# timeout signals the whole process group, so npm's or pip's children stop too.
if [ -n "$TEST_INSTALL" ] && ! timeout -k 5 "${TEST_INSTALL_TIMEOUT:-180}" bash -c "$TEST_INSTALL" >&2; then
  TEST_RUN=""; TEST_SKIP="dependencies could not be installed"
fi
if [ -n "$TEST_RUN" ]; then
  bash -c "$TEST_RUN" >&2
  TEST_EXIT=$?
  emit test_result "$TEST_EXIT"
else
  TEST_EXIT=0
  # TEST_SKIP is always one of four fixed phrases (no quotes or backslashes), so it is safe inside the JSON string.
  printf '{"type":"test_result","ts":%s,"exitCode":0,"skipped":"%s"}\n' "$(now)" "$TEST_SKIP"
fi

echo "__DIFF_START__"
cat "$PATCH"
echo "__DIFF_END__"
exit "$TEST_EXIT"
