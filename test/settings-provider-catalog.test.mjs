// settings-provider-catalog.test.mjs — FE-1 provider catalog parser unit tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseProviderCatalog,
  loadProviderCatalog,
  settingsYamlPath,
} from "../lib/settings-provider-catalog.mjs";

const SAMPLE = `ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
llm-pi-ai:
  providers:
    jl-token:
      displayName: jl-token
      apiKeyEnv: JL_TOKEN_API_KEY
      api: openai-completions
      baseURL: http://cdn.shenkeinfo.net/v1
      models:
        - id: DeepSeek-V4-Flash
          name: DeepSeek-V4-Flash
        - id: Kimi-K2.6
          name: Kimi-K2.6
    minimax-cn:
      models:
        - id: MiniMax-M2.7
          name: MiniMax-M2.7
          contextWindow: 204800
        - id: MiniMax-M3
          name: MiniMax-M3
      apiKeyEnv: MINIMAX_CN_API_KEY
agent-default-model:
  provider: jl-token
  model: DeepSeek-V4-Flash
`;

test("parses llm-pi-ai.providers into provider/model entries", () => {
  const cat = parseProviderCatalog(SAMPLE);
  assert.equal(cat.length, 4);
  assert.deepEqual(
    cat.map((c) => `${c.provider}/${c.model}`),
    [
      "jl-token/DeepSeek-V4-Flash",
      "jl-token/Kimi-K2.6",
      "minimax-cn/MiniMax-M2.7",
      "minimax-cn/MiniMax-M3",
    ],
  );
});

test("does not swallow interleaved non-models keys in a provider block", () => {
  const cat = parseProviderCatalog(SAMPLE);
  const mini = cat.filter((c) => c.provider === "minimax-cn");
  // apiKeyEnv appears AFTER models in the sample; the minimax models must still be found.
  assert.equal(mini.length, 2);
});

test("always prefixes the provider so same-named models are distinguishable", () => {
  // SAMPLE: jl-token has displayName: jl-token (== key); minimax-cn has none.
  const cat = parseProviderCatalog(SAMPLE);
  assert.equal(cat[0].name, "jl-token · DeepSeek-V4-Flash");
  // minimax-cn entry falls back to the provider key as its label.
  assert.equal(cat[2].name, "minimax-cn · MiniMax-M2.7");
  // An explicit displayName is still honored.
  const withName = SAMPLE.replace("displayName: jl-token", "displayName: JLT 供应商");
  assert.equal(parseProviderCatalog(withName)[0].name, "JLT 供应商 · DeepSeek-V4-Flash");
});

test("returns [] on empty / no llm-pi-ai subtree", () => {
  assert.deepEqual(parseProviderCatalog(""), []);
  assert.deepEqual(parseProviderCatalog("# only a comment\nfoo: bar\n"), []);
});

test("tolerates scrub / table-shaped name indentation (name deeper than id)", () => {
  // Regression: some editors align `name:` under the `id` value column (indent
  // one level deeper than `- id:`). Must not lose the model.
  const weird = `llm-pi-ai:
  providers:
    p1:
      models:
        - id: A
          name: A-name
`;
  const cat = parseProviderCatalog(weird);
  assert.equal(cat.length, 1);
  assert.equal(cat[0].provider, "p1");
  assert.equal(cat[0].model, "A");
});

test("settingsYamlPath defaults to ~/.dsh when DSH_HOME is unset", () => {
  const p = settingsYamlPath({});
  assert.ok(p.endsWith("/.dsh/settings.yaml"), p);
});

test("settingsYamlPath uses DSH_HOME when set (without appending .dsh)", () => {
  const p = settingsYamlPath({ DSH_HOME: "/tmp/mydsh" });
  assert.equal(p, "/tmp/mydsh/settings.yaml");
});

test("loadProviderCatalog returns [] when file missing", () => {
  const cat = loadProviderCatalog({ DSH_HOME: "/nonexistent-dsh-home-xyz" });
  assert.deepEqual(cat, []);
});
