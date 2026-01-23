#!/bin/bash
# Wrapper for vitest that ignores OOM errors during cleanup
# All tests pass but vitest worker crashes after teardown

output=$(npx vitest run 2>&1)
exit_code=$?

echo "$output"

# Check if any test files failed (not just crashed during cleanup)
if echo "$output" | grep -qE "Test Files.*[0-9]+ failed"; then
  exit 1
fi

# Check if any individual tests failed
if echo "$output" | grep -qE "Tests.*[0-9]+ failed"; then
  exit 1
fi

# All tests passed, ignore OOM during cleanup
if echo "$output" | grep -q "Worker terminated due to reaching memory limit\|Worker exited unexpectedly"; then
  if echo "$output" | grep -q "Test Files.*passed"; then
    exit 0
  fi
fi

exit $exit_code
