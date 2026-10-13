// test/degrade.test.mjs — degrade.mjs 单元测试
import test from "node:test";
import assert from "node:assert/strict";

import {
  formatJson, formatText, formatStartupDiagnosis, formatStartupSummary,
  formatReport, renderManualResidue, MANUAL_RESIDUE, exitCodeFor,
} from "../lib/selfcheck/degrade.mjs";

const SAMPLE_REPORT = {
  root: "/var/dsh",
  runtime: "spawn",
  durationMs: 42,
  checks: [
    { id: "ZOD_MISSING", status: "fail", severity: "high", fixable: true, title: "zod missing", detail: "no zod" },
    { id: "OBSIDIAN_DATA_JSON_MISSING", status: "pass", severity: "high", fixable: false, title: "ok" },
  ],
  findings: [
    { id: "ZOD_MISSING", status: "fail", detail: "no zod" },
  ],
  actions: [
    { code: "ZOD_MISSING", kind: "plan-only", plan: "npm i zod", applied: false },
  ],
  backups: [],
  nextSteps: ["install zod", "rerun doctor"],
};

test("degrade: formatJson round-trips a report", () => {
  const s = formatJson(SAMPLE_REPORT);
  const j = JSON.parse(s);
  assert.equal(j.root, "/var/dsh");
  assert.equal(j.findings[0].id, "ZOD_MISSING");
});

test("degrade: formatText contains root + check ids + finding", () => {
  const s = formatText(SAMPLE_REPORT);
  assert.match(s, /dsh-acp self-check/);
  assert.match(s, /ZOD_MISSING/);
  assert.match(s, /no zod/);
  assert.match(s, /install zod/);   // nextStep
});

test("degrade: formatStartupDiagnosis surfaces blocking findings", () => {
  const s = formatStartupDiagnosis(SAMPLE_REPORT);
  assert.match(s, /1 blocking/);
  assert.match(s, /ZOD_MISSING/);
});

test("degrade: formatStartupDiagnosis returns 'ok' when no fail", () => {
  const s = formatStartupDiagnosis({ findings: [] });
  assert.match(s, /ok/);
});

test("degrade: formatStartupSummary is single-line", () => {
  const s = formatStartupSummary(SAMPLE_REPORT);
  assert.equal(s.split("\n").length, 1);
  assert.match(s, /1 finding\(s\)/);
  assert.match(s, /1 fail/);
});

test("degrade: formatReport routes JSON when opts.json", () => {
  const j = formatReport(SAMPLE_REPORT, { json: true });
  assert.ok(j.startsWith("{") || j.startsWith("["));
});

test("degrade: renderManualResidue defaults to MANUAL_RESIDUE", () => {
  const s = renderManualResidue();
  assert.match(s, /Manual cleanup residue/);
  assert.ok(s.length > 100);
});

test("degrade: MANUAL_RESIDUE is frozen and well-formed", () => {
  assert.equal(Object.isFrozen(MANUAL_RESIDUE), true);
  for (const e of MANUAL_RESIDUE) {
    assert.ok(typeof e.code === "string");
    assert.ok(typeof e.title === "string");
    assert.ok(Array.isArray(e.steps));
  }
});

test("degrade: exitCodeFor returns 0/1/2", () => {
  assert.equal(exitCodeFor({ findings: [] }), 0);
  assert.equal(exitCodeFor({ findings: [{ status: "warn" }] }), 1);
  assert.equal(exitCodeFor({ findings: [{ status: "fail" }] }), 1);
  assert.equal(exitCodeFor({ error: "x" }), 2);
  assert.equal(exitCodeFor({ code: "FIXTURE_ESCAPE" }), 2);
});
