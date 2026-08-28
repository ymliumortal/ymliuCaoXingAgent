import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_PROTOCOLS,
  AI_PROVIDER_PRESETS,
  DEFAULT_AI_SETTINGS,
  normalizeAiHistory,
  normalizeAiSettings,
} from "../src/core/ai.mjs";

test("AI 默认设置保持关闭并使用手动配置", () => {
  const settings = normalizeAiSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.provider, "manual");
  assert.equal(settings.protocol, DEFAULT_AI_SETTINGS.protocol);
  assert.equal(settings.model, "");
  assert.equal("temperature" in settings, false);
  assert.equal("maxTokens" in settings, false);
});

test("API Manager 只暴露 Chat 和 Responses 协议", () => {
  assert.deepEqual(AI_PROVIDER_PRESETS["api-manager"].protocols, ["openai-chat", "openai-responses"]);
  const settings = normalizeAiSettings({ provider: "api-manager", protocol: "gemini-generate", baseUrl: " http://127.0.0.1:8420/v1 ", enabled: "true" });
  assert.equal(settings.enabled, true);
  assert.equal(settings.protocol, "openai-chat");
  assert.equal(settings.baseUrl, "http://127.0.0.1:8420/v1");
});

test("模型平台默认不填模型，并提供平台自己的候选模型", () => {
  for (const provider of ["openai", "anthropic", "xai", "gemini", "deepseek", "glm", "kimi"]) {
    assert.equal(AI_PROVIDER_PRESETS[provider].model, "");
    assert.ok(AI_PROVIDER_PRESETS[provider].models.length > 0);
  }
  assert.equal(AI_PROVIDER_PRESETS.deepseek.baseUrl, "https://api.deepseek.com");
  assert.ok(AI_PROVIDER_PRESETS.deepseek.models.includes("deepseek-v4-flash-vision-exp"));
  assert.ok(AI_PROVIDER_PRESETS.deepseek.models.includes("deepseek-v4-flash"));
  assert.ok(AI_PROVIDER_PRESETS.deepseek.models.includes("deepseek-v4-pro"));
  const removedDeepSeekModels = ["chat", "reasoner"].map((suffix) => `deepseek-${suffix}`);
  for (const model of removedDeepSeekModels) assert.ok(!AI_PROVIDER_PRESETS.deepseek.models.includes(model));
  for (const model of removedDeepSeekModels) assert.equal(normalizeAiSettings({ provider: "deepseek", model }).model, "");
});

test("DeepSeek 官方旧版 Base URL 会统一为根地址", () => {
  assert.equal(normalizeAiSettings({ provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }).baseUrl, "https://api.deepseek.com");
  assert.equal(normalizeAiHistory([{ id: "legacy", provider: "deepseek", baseUrl: "https://api.deepseek.com/v1" }])[0].baseUrl, "https://api.deepseek.com");
});

test("预设平台覆盖日志中的主要模型服务和协议", () => {
  for (const provider of ["openai", "anthropic", "xai", "gemini", "deepseek", "glm", "kimi"]) {
    const preset = AI_PROVIDER_PRESETS[provider];
    assert.ok(preset.baseUrl, `${provider} should have a base URL`);
    assert.ok(preset.protocols.includes(preset.protocol), `${provider} protocol should be selectable`);
  }
  assert.deepEqual(Object.keys(AI_PROTOCOLS), ["openai-chat", "openai-responses", "anthropic-messages", "gemini-generate"]);
});

test("已删除的模型参数不会进入账户配置", () => {
  const settings = normalizeAiSettings({ temperature: 9, maxTokens: 1 });
  assert.equal(settings.temperature, undefined);
  assert.equal(settings.maxTokens, undefined);
});

test("历史接口记录只保留可展示的连接信息", () => {
  const history = normalizeAiHistory([
    { id: "one", provider: "openai", baseUrl: "https://example.test/v1", model: "demo", apiKey: "must-not-be-kept", testStatus: "success", latencyMs: "120" },
    { id: "invalid", provider: "not-a-provider", model: "ignore" },
  ]);
  assert.equal(history.length, 1);
  assert.equal(history[0].apiKey, undefined);
  assert.equal(history[0].apiKeyConfigured, false);
  assert.equal(history[0].latencyMs, 120);
});
