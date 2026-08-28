export const AI_PROTOCOLS = {
  "openai-chat": { label: "OpenAI Chat Completions" },
  "openai-responses": { label: "OpenAI Responses" },
  "anthropic-messages": { label: "Anthropic Messages" },
  "gemini-generate": { label: "Google Gemini generateContent" },
};

export const AI_PROVIDER_PRESETS = {
  "api-manager": {
    label: "API Manager",
    description: "使用 API Manager 项目专用 Key 统一调度模型",
    baseUrl: "http://127.0.0.1:8420/v1",
    protocol: "openai-chat",
    protocols: ["openai-chat", "openai-responses"],
    model: "",
    models: [],
    keyLabel: "项目专用 API Key",
  },
  openai: {
    label: "OpenAI",
    description: "OpenAI Chat 或 Responses 兼容接口",
    baseUrl: "https://api.openai.com/v1",
    protocol: "openai-responses",
    protocols: ["openai-chat", "openai-responses"],
    model: "",
    models: ["gpt-4o-mini", "gpt-4.1-mini"],
    keyLabel: "OpenAI API Key",
  },
  anthropic: {
    label: "Claude / Anthropic",
    description: "Anthropic Messages 接口",
    baseUrl: "https://api.anthropic.com/v1",
    protocol: "anthropic-messages",
    protocols: ["anthropic-messages"],
    model: "",
    models: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
    keyLabel: "Anthropic API Key",
  },
  xai: {
    label: "Grok / xAI",
    description: "xAI OpenAI 兼容接口",
    baseUrl: "https://api.x.ai/v1",
    protocol: "openai-chat",
    protocols: ["openai-chat"],
    model: "",
    models: ["grok-3-mini", "grok-3"],
    keyLabel: "xAI API Key",
  },
  gemini: {
    label: "Gemini / Google",
    description: "Google Gemini generateContent 接口",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    protocol: "gemini-generate",
    protocols: ["gemini-generate"],
    model: "",
    models: ["gemini-2.0-flash", "gemini-1.5-flash"],
    keyLabel: "Google AI API Key",
  },
  deepseek: {
    label: "DeepSeek",
    description: "DeepSeek OpenAI 兼容接口（支持视觉模型）",
    baseUrl: "https://api.deepseek.com",
    protocol: "openai-chat",
    protocols: ["openai-chat"],
    model: "",
    models: ["deepseek-v4-flash-vision-exp", "deepseek-v4-flash", "deepseek-v4-pro"],
    keyLabel: "API Key",
  },
  glm: {
    label: "GLM / 智谱",
    description: "智谱 BigModel OpenAI 兼容接口",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    protocol: "openai-chat",
    protocols: ["openai-chat"],
    model: "",
    models: ["glm-5.3", "glm-5.2", "glm-4.7", "glm-4-flash", "glm-4-air"],
    keyLabel: "智谱 API Key",
  },
  kimi: {
    label: "Kimi / Moonshot",
    description: "Moonshot OpenAI 兼容接口",
    baseUrl: "https://api.moonshot.cn/v1",
    protocol: "openai-chat",
    protocols: ["openai-chat"],
    model: "",
    models: ["kimi-k3", "moonshot-v1-8k"],
    keyLabel: "Moonshot API Key",
  },
  orcarouter: {
    label: "OrcaRouter",
    description: "OrcaRouter 多模型 OpenAI 兼容网关",
    baseUrl: "https://api.orcarouter.ai/v1",
    protocol: "openai-chat",
    protocols: ["openai-chat", "openai-responses"],
    model: "",
    models: ["orcarouter/auto"],
    keyLabel: "OrcaRouter API Key",
  },
  manual: {
    label: "手动配置",
    description: "填写任意兼容接口的 Base URL、协议和模型",
    baseUrl: "",
    protocol: "openai-chat",
    protocols: Object.keys(AI_PROTOCOLS),
    model: "",
    models: [],
    keyLabel: "API Key",
  },
};

export const DEFAULT_AI_SETTINGS = {
  enabled: false,
  provider: "manual",
  baseUrl: "",
  model: "",
  protocol: "openai-chat",
  apiKey: "",
};

export const AI_HISTORY_LIMIT = 12;

function booleanValue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function cleanModelName(value) {
  const model = typeof value === "string" ? value.trim() : "";
  return /^(?:deepseek)-(?:chat|reasoner)$/i.test(model) ? "" : model;
}

function normalizeProviderBaseUrl(provider, value, fallback = "") {
  const base = typeof value === "string" ? value.trim() : String(fallback || "").trim();
  if (provider === "deepseek" && /^https?:\/\/api\.deepseek\.com\/v1$/i.test(base)) {
    return base.replace(/\/v1$/i, "");
  }
  return base;
}

export function normalizeAiSettings(input = {}) {
  const provider = AI_PROVIDER_PRESETS[input.provider] ? input.provider : DEFAULT_AI_SETTINGS.provider;
  const preset = AI_PROVIDER_PRESETS[provider];
  const protocols = preset.protocols || Object.keys(AI_PROTOCOLS);
  const protocol = protocols.includes(input.protocol) ? input.protocol : preset.protocol;
  return {
    enabled: booleanValue(input.enabled),
    provider,
    baseUrl: normalizeProviderBaseUrl(provider, input.baseUrl, preset.baseUrl),
    model: cleanModelName(typeof input.model === "string" ? input.model : preset.model),
    protocol,
    apiKey: typeof input.apiKey === "string" ? input.apiKey : "",
  };
}

export function normalizeAiHistory(input = []) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const provider = typeof item.provider === "string" ? item.provider : "manual";
      return {
        id: typeof item.id === "string" ? item.id : "",
        provider,
        baseUrl: normalizeProviderBaseUrl(provider, item.baseUrl),
        model: cleanModelName(typeof item.model === "string" ? item.model : ""),
        protocol: typeof item.protocol === "string" ? item.protocol : "openai-chat",
        apiKeyConfigured: Boolean(item.apiKeyConfigured),
        savedAt: typeof item.savedAt === "string" ? item.savedAt : "",
        testedAt: typeof item.testedAt === "string" ? item.testedAt : "",
        testStatus: typeof item.testStatus === "string" ? item.testStatus : "not-tested",
        testMessage: typeof item.testMessage === "string" ? item.testMessage : "",
        latencyMs: Number.isFinite(Number(item.latencyMs)) ? Number(item.latencyMs) : null,
      };
    })
    .filter((item) => AI_PROVIDER_PRESETS[item.provider])
    .slice(0, AI_HISTORY_LIMIT);
}

export function providerPreset(provider) {
  return AI_PROVIDER_PRESETS[provider] || AI_PROVIDER_PRESETS.manual;
}

export function providerLabel(provider) {
  return providerPreset(provider).label;
}
