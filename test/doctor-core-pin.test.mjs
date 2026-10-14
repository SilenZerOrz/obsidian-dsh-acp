// test/doctor-core-pin.test.mjs — dist-tags.latest 指向旧版 → 核心包必须逐包 pin
import test from "node:test";
import assert from "node:assert/strict";

import { DSH_CORE_PACKAGES, DSH_CORE_MIN_PIN, detectCorePinVersion, pinnedCorePackages, diagnoseHeadlessProfile, formatDiagnosis } from "../doctor.mjs";

test("doctor core pin: all 5 packages listed", () => {
  assert.equal(DSH_CORE_PACKAGES.length, 5);
  for (const p of DSH_CORE_PACKAGES) assert.match(p, /^@deepseek-ai\/dsh-/);
});

test("doctor core pin: pinnedCorePackages pins EVERY package (no bare install)", () => {
  const s = pinnedCorePackages("0.2.1-alpha.1");
  for (const p of DSH_CORE_PACKAGES) {
    assert.match(s, new RegExp(`${p.replace("/", "\\/")}@0\\.2\\.1-alpha\\.1`), `${p} must carry an explicit @version`);
  }
  // no bare `@deepseek-ai/dsh-base ` (without @version) — regression guard
  assert.equal(/\@deepseek-ai\/dsh-base\s/.test(s), false, "must not leave a package unpinned");
});

test("doctor core pin: detectCorePinVersion returns a semver or the fallback", () => {
  const v = detectCorePinVersion();
  assert.match(v, /^\d+\.\d+\.\d+/, `expected semver, got ${v}`);
});

test("doctor core pin: pinnedCorePackages falls back to DSH_CORE_MIN_PIN on empty", () => {
  const s = pinnedCorePackages("");
  for (const p of DSH_CORE_PACKAGES) assert.match(s, new RegExp(`${p.replace("/", "\\/")}@${DSH_CORE_MIN_PIN.replace(/\./g, "\\.")}`));
});

test("doctor core pin: install hints never emit a bare upstream install", () => {
  // The headless-profile-missing / package.json-missing hints must not contain
  // an unpinned "@deepseek-ai/dsh-<pkg> " token (regression guard for the
  // dist-tags.latest stale-version bug).
  const issues = diagnoseHeadlessProfile();
  const text = issues.map((i) => (i.fix || []).join("\n")).join("\n");
  assert.equal(/@deepseek-ai\/dsh-(base|headless|llm|agent-loop|acp)\s/.test(text), false,
    "no bare @deepseek-ai/dsh-* install in doctor fix hints");
});
