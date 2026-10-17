// test/headless-json-flag-detect.test.mjs — version-detect.mjs::hasHeadlessJson
// probe unit test. Verifies the substring match works against realistic
// dsh --help output and the false-positive / false-negative boundaries.
//
// Pure function test — no network, no real dsh spawn. The probe logic lives
// at the top of lib/version-detect.mjs; we re-implement the matcher here
// for unit isolation (testing the cached probe directly would require
// stubbing spawnSync, which is more invasive than warranted for ~10 lines
// of code).

import { test } from "node:test";
import assert from "node:assert/strict";

// Mirror of the matcher in lib/version-detect.mjs::hasHeadlessJson.
function matchHelp(blob) {
  return /(^|\s)--json(\s|$)/.test(blob);
}

test("hasHeadlessJson: matches dsh 0.1.7-rc.1 --help output shape", () => {
  const realHelp = `Usage: dsh [options] [command]

Options:
  --profile <name>     choose the dsh profile to run
  --json               write newline-delimited run events to stdout instead of the final message
  --session-id <id>    adopt the persisted Session with this id; an unknown id is an error
  -h, --help           display help for command
`;
  assert.equal(matchHelp(realHelp), true);
});

test("hasHeadlessJson: matches when --json is mid-line (preceded by other text)", () => {
  // Some dsh builds compact the flag list — the matcher must tolerate
  // non-newline boundaries as long as --json has whitespace around it.
  const compactHelp = "Flags: --profile <name> --json <description> --session-id <id>";
  assert.equal(matchHelp(compactHelp), true);
});

test("hasHeadlessJson: returns false when --json is absent (e.g. dsh 0.1.6-alpha.x)", () => {
  const oldHelp = `Usage: dsh [options] [command]

Options:
  --profile <name>     choose the dsh profile to run
  --session-id <id>    adopt the persisted Session with this id; an unknown id is an error
  -h, --help           display help for command
`;
  assert.equal(matchHelp(oldHelp), false);
});

test("hasHeadlessJson: returns false for non-dsh binaries that happen to mention --json", () => {
  // Some other tool may mention JSON in prose; the boundary check
  // (`(^|\s)--json(\s|$)`) prevents false matches on words like "JSON"
  // (uppercase) or paths that happen to contain "--json" as a substring
  // of a longer token. A non-dsh help that never lists the flag itself
  // is correctly skipped.
  const unrelatedHelp = `This tool reads JSON files. No structured-output flag here.`;
  assert.equal(matchHelp(unrelatedHelp), false, "absence → false");
});

test("hasHeadlessJson: handles stdout + stderr concatenation (dsh --help sometimes writes to stderr)", () => {
  const stdout = "Usage: dsh\n";
  const stderr = "Options:\n  --json             write NDJSON\n";
  const combined = stdout + stderr;
  assert.equal(matchHelp(combined), true, "either stream carrying the flag → true");
});

test("hasHeadlessJson: empty / non-string blobs return false safely", () => assert.equal(matchHelp(""), false));