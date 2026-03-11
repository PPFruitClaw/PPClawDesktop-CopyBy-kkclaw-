/**
 * 🔄 Model Switcher V3 — CC Switch 风格模型管理器
 * 
 * 参考 CC Switch (17k⭐) 设计:
 * - 卡片式 Provider 管理
 * - 丰富的预设模板（含中转站）
 * - API 延迟测速
 * - "Currently Using" 状态标记
 * - Provider 图标和品牌色
 * - 拖拽排序
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const SwitchLogger = require('./utils/switch-logger');
const pathResolver = require('./utils/openclaw-path-resolver');
const { ModelSwitchStateMachine, SwitchState } = require('./utils/model-switch-state-machine');
const { getStrategy } = require('./utils/model-switch-strategies');
const SwitchHistory = require('./utils/switch-history');
const GatewaySmartDetector = require('./utils/gateway-smart-detector');
const ConfigWriter = require('./utils/config-writer');
const SessionLockManager = require('./utils/session-lock-manager');
const ccSwitchSync = require('./utils/cc-switch-sync');
const QuotaQuery = require('./utils/quota-query');

// ===== 预设 Provider 模板（参考 CC Switch 的 17+ 预设） =====
const PROVIDER_PRESETS = {
  // ── 官方 ──
  'anthropic': {
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    website: 'https://console.anthropic.com',
    api: 'anthropic-messages',
    icon: '✦',
    color: '#D97757',
    description: 'Claude 官方 API',
    models: [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', reasoning: false, contextWindow: 200000, maxTokens: 8192 },
    ]
  },
  'openai': {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    website: 'https://platform.openai.com',
    api: 'openai-completions',
    icon: '◎',
    color: '#10A37F',
    description: 'GPT 官方 API',
    models: [
      { id: 'gpt-5.4', name: 'GPT-5.4', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.2', name: 'GPT-5.2', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.1', name: 'GPT-5.1', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5', name: 'GPT-5', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
    ]
  },
  'google': {
    name: 'Google AI',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    website: 'https://aistudio.google.com',
    api: 'openai-completions',
    icon: '✦',
    color: '#4285F4',
    description: 'Gemini 官方 API',
    models: [
      { id: 'gemini', name: 'Gemini', reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
    ]
  },
  'deepseek': {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    website: 'https://platform.deepseek.com',
    api: 'openai-completions',
    icon: '⬡',
    color: '#4D6BFE',
    description: 'DeepSeek 官方 API',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek V3', reasoning: false, contextWindow: 64000, maxTokens: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', reasoning: true, contextWindow: 64000, maxTokens: 8192 },
    ]
  },
  // ── 中转站 ──
  'kkclaw': {
    name: 'KKCLAW 拼车',
    baseUrl: 'https://gptclubapi.xyz',
    website: 'https://gptclubapi.xyz',
    api: 'multi-protocol',
    icon: '🚗',
    color: '#FF6B35',
    description: 'KK拼车多协议中转站',
    features: ['quota-query', 'multi-protocol'],
    pathMapping: {
      'claude': '/api/v1',
      'gemini': '/gemini/v1',
      'openai': '/openai/v1'
    },
    models: [
      // Claude
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', api: 'anthropic-messages', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', api: 'anthropic-messages', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', api: 'anthropic-messages', reasoning: false, contextWindow: 200000, maxTokens: 8192 },
      // Gemini
      { id: 'gemini', name: 'Gemini', api: 'openai-completions', reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', api: 'openai-completions', reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', api: 'openai-completions', reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', api: 'openai-completions', reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', api: 'openai-completions', reasoning: true, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', api: 'openai-completions', reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite', api: 'openai-completions', reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
      // Codex / GPT
      { id: 'gpt-5.4', name: 'GPT-5.4', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.2', name: 'GPT-5.2', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.1', name: 'GPT-5.1', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5', name: 'GPT-5', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 16000 },
      { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5-codex', name: 'GPT-5 Codex', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'gpt-5-codex-mini', name: 'GPT-5 Codex Mini', api: 'openai-responses', reasoning: true, contextWindow: 200000, maxTokens: 16000 },
    ]
  },
  'openrouter': {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    website: 'https://openrouter.ai',
    api: 'openai-completions',
    icon: '⊕',
    color: '#6366F1',
    description: '多模型聚合中转',
    models: [
      { id: 'anthropic/claude-opus-4-6', name: 'Claude Opus 4.6', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'openai/gpt-5.4', name: 'GPT-5.4', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', reasoning: true, contextWindow: 200000, maxTokens: 32000 },
      { id: 'google/gemini-3-flash-preview', name: 'Gemini 3 Flash', reasoning: false, contextWindow: 1000000, maxTokens: 65536 },
    ]
  },
  'zhipu-glm': {
    name: 'Z.ai GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    website: 'https://z.ai',
    api: 'openai-completions',
    icon: 'Z',
    color: '#4361EE',
    description: '智谱 GLM 编码计划',
    models: [
      { id: 'glm-4-plus', name: 'GLM-4 Plus', reasoning: false, contextWindow: 128000, maxTokens: 4096 },
    ]
  },
  'qwen-coder': {
    name: 'Qwen Coder',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    website: 'https://bailian.console.aliyun.com',
    api: 'openai-completions',
    icon: 'Q',
    color: '#6236FF',
    description: '通义千问百炼平台',
    models: [
      { id: 'qwen-max', name: 'Qwen Max', reasoning: false, contextWindow: 32000, maxTokens: 8192 },
      { id: 'qwen-turbo', name: 'Qwen Turbo', reasoning: false, contextWindow: 128000, maxTokens: 8192 },
    ]
  },
  'kimi': {
    name: 'Kimi For Coding',
    baseUrl: 'https://api.moonshot.cn/v1',
    website: 'https://www.kimi.com/coding/docs/',
    api: 'openai-completions',
    icon: 'K',
    color: '#000000',
    description: 'Kimi K2 编码模型',
    models: [
      { id: 'kimi-k2-0711-preview', name: 'Kimi K2', reasoning: true, contextWindow: 128000, maxTokens: 8192 },
    ]
  },
  'minimax': {
    name: 'MiniMax',
    baseUrl: 'https://api.minimaxi.chat/v1',
    website: 'https://platform.minimaxi.com',
    api: 'openai-completions',
    icon: 'M',
    color: '#FF4040',
    description: 'MiniMax M2 模型',
    models: [
      { id: 'MiniMax-M1-80k', name: 'MiniMax M1', reasoning: false, contextWindow: 80000, maxTokens: 8192 },
    ]
  },
  // 自定义中转站模板
  'custom-proxy': {
    name: '自定义中转站',
    baseUrl: 'https://api.kk666.online/v1',
    website: 'https://api.kk666.online',
    api: 'anthropic-messages',
    icon: '⚙',
    color: '#888888',
    description: '自定义 API 端点',
    models: []
  }
};

// ===== API 类型映射（与 OpenClaw 兼容） =====
const API_TYPES = {
  'anthropic-messages': { label: 'Anthropic Messages API', brands: ['Claude'] },
  'openai-completions': { label: 'OpenAI Chat Completions', brands: ['GPT', 'DeepSeek', 'Qwen', 'Llama', 'Gemini', 'GLM'] },
  'openai-responses': { label: 'OpenAI Responses API', brands: ['GPT-5', 'Codex', 'o3', 'o4'] },
};

const KNOWN_API_KEYS = new Set(Object.keys(API_TYPES));

class ModelSwitcher {
  constructor(options = {}) {
    this.configPath = options.configPath || pathResolver.getConfigPath();
    this.gatewayPort = options.port || 18789;
    this.gatewayToken = options.token || '';

    this.models = [];         // 所有可用模型（扁平列表）
    this.providers = {};      // provider 详情（含 apiKey）
    this.currentModel = null; // 当前激活模型
    this.currentIndex = 0;    // 当前模型索引
    this.listeners = [];      // 变更监听器
    this.speedTestResults = {};  // 测速结果缓存
    this.providerOrder = [];    // Provider 排序
    this.lastSwitchResult = null; // 最近一次切换结果（给 UI 精确反馈）
    this.quotaCache = new Map(); // 配额缓存 { providerName: { data, timestamp } }

    // 监控日志
    this.switchLog = new SwitchLogger();

    // 新增：状态机、历史、检测器、配置写入器
    this.stateMachine = new ModelSwitchStateMachine();
    this.switchHistory = new SwitchHistory();
    this.gatewayDetector = new GatewaySmartDetector(`http://127.0.0.1:${this.gatewayPort}`);
    this.configWriter = new ConfigWriter(this.configPath);
    this.switchStrategy = options.strategy || 'safe'; // fast | safe | smart

    // 监听状态变化
    this.stateMachine.on('state-change', (event) => {
      this._onStateChange(event);
    });

    this._loadConfig();
    this._migrateModelProtocolsInConfig();

    // 自动同步 cc-switch providers（暂时注释，需要时手动调用）
    // this.syncFromCCSwitch();
  }

  // ==================== 配置读写 ====================

  _setLastSwitchResult(result) {
    this.lastSwitchResult = {
      timestamp: Date.now(),
      ...result
    };
    return this.lastSwitchResult;
  }

  getLastSwitchResult() {
    if (!this.lastSwitchResult) return null;
    return { ...this.lastSwitchResult };
  }

  _normalizeApiType(api) {
    if (!api || typeof api !== 'string') return null;
    const normalized = api.trim().toLowerCase();
    return KNOWN_API_KEYS.has(normalized) ? normalized : null;
  }

  _resolveModelBaseUrl(modelBaseUrl, providerBaseUrl, modelId, pathMapping) {
    // 如果模型已指定 baseURL，按原逻辑处理
    if (modelBaseUrl) {
      // 完整 URL（http:// 或 https://），直接使用
      if (/^https?:\/\//i.test(modelBaseUrl)) return modelBaseUrl;
      // 相对路径（以 / 开头），拼接到 provider baseURL
      if (modelBaseUrl.startsWith('/')) {
        const base = (providerBaseUrl || '').replace(/\/+$/, '');
        return base + modelBaseUrl;
      }
      return modelBaseUrl;
    }

    // 如果 provider 有 pathMapping，根据模型 ID 自动推断路径
    if (pathMapping && modelId) {
      const id = modelId.toLowerCase();
      let pathSuffix = null;

      if (id.startsWith('claude-')) {
        pathSuffix = pathMapping.claude || pathMapping.anthropic;
      } else if (id.startsWith('gemini-')) {
        pathSuffix = pathMapping.gemini || pathMapping.google;
      } else if (id.startsWith('gpt-') || id.includes('codex')) {
        pathSuffix = pathMapping.openai || pathMapping.codex;
      }

      if (pathSuffix) {
        return this._joinBaseWithSuffix(providerBaseUrl, pathSuffix);
      }
    }

    // 默认使用 provider 的 baseURL
    return providerBaseUrl || '';
  }

  _joinBaseWithSuffix(baseUrl, pathSuffix) {
    const base = String(baseUrl || '').trim();
    const suffix = String(pathSuffix || '').trim();
    if (!base) return suffix;
    if (!suffix) return base;
    if (/^https?:\/\//i.test(suffix)) return suffix;

    try {
      const url = new URL(base);
      const basePath = (url.pathname || '/').replace(/\/+$/, '') || '/';
      let suffixPath = suffix.startsWith('/') ? suffix : `/${suffix}`;
      suffixPath = suffixPath.replace(/\/+$/, '') || '/';

      const relayRoots = ['/api', '/openai', '/gemini'];
      const isRelayRoot = relayRoots.includes(basePath);
      const isRelaySuffix = relayRoots.some((root) => suffixPath === root || suffixPath.startsWith(`${root}/`));

      let finalPath = suffixPath;
      if (!isRelayRoot || !isRelaySuffix) {
        if (basePath !== '/' && suffixPath !== basePath && !suffixPath.startsWith(`${basePath}/`)) {
          finalPath = `${basePath}${suffixPath}`.replace(/\/{2,}/g, '/');
        }
      }

      url.pathname = finalPath;
      url.search = '';
      url.hash = '';
      return url.toString().replace(/\/+$/, '');
    } catch {
      const normalizedBase = base.replace(/\/+$/, '');
      const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
      if (normalizedBase.endsWith(normalizedSuffix)) return normalizedBase;
      return `${normalizedBase}${normalizedSuffix}`;
    }
  }

  _guessApiByModelId(modelId) {
    const id = String(modelId || '').toLowerCase();
    if (!id) return null;

    // Claude 系列
    if (id.startsWith('claude-')) return 'anthropic-messages';

    // Gemini 系列
    if (id.startsWith('gemini-')) return 'openai-completions';

    // Codex / GPT-5 系列
    if (id.includes('codex') || id.startsWith('gpt-5')) return 'openai-responses';

    return null;
  }

  _isDirectOpenAIBaseUrl(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return false;
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      return host === 'api.openai.com' || host === 'chatgpt.com' || host.endsWith('.openai.azure.com');
    } catch {
      const normalized = baseUrl.toLowerCase();
      return normalized.includes('api.openai.com') || normalized.includes('chatgpt.com') || normalized.includes('.openai.azure.com');
    }
  }

  _detectApiByBaseUrlSuffix(baseUrl) {
    if (!baseUrl || typeof baseUrl !== 'string') return null;
    const raw = baseUrl.trim();
    if (!raw) return null;

    let urlLower = raw.toLowerCase();
    let pathname = '';
    try {
      const parsed = new URL(raw);
      urlLower = parsed.toString().toLowerCase();
      pathname = parsed.pathname.toLowerCase().replace(/\/+$/, '');
    } catch {
      const fallback = raw.toLowerCase().split(/[?#]/)[0];
      const idx = fallback.indexOf('://');
      pathname = idx >= 0 ? fallback.slice(fallback.indexOf('/', idx + 3)) : fallback;
      pathname = pathname.replace(/\/+$/, '');
    }

    // 最高优先级：直接指向具体端点
    if (/\/v\d+\/messages$/.test(pathname) || pathname.endsWith('/messages')) {
      return { api: 'anthropic-messages', confidence: 'high', reason: 'path:/messages' };
    }
    if (/\/v\d+\/responses$/.test(pathname) || pathname.endsWith('/responses')) {
      return { api: 'openai-responses', confidence: 'high', reason: 'path:/responses' };
    }
    if (/\/v\d+\/chat\/completions$/.test(pathname) || pathname.endsWith('/chat/completions')) {
      return { api: 'openai-completions', confidence: 'high', reason: 'path:/chat/completions' };
    }

    // 中优先级：中转路径后缀
    if (pathname.endsWith('/openai') || pathname.includes('/openai/')) {
      return { api: 'openai-completions', confidence: 'medium', reason: 'path:/openai' };
    }
    if (pathname.endsWith('/gemini') || pathname.includes('/gemini/')) {
      return { api: 'openai-completions', confidence: 'medium', reason: 'path:/gemini' };
    }
    if (pathname.includes('/compatible-mode')) {
      return { api: 'openai-completions', confidence: 'medium', reason: 'path:/compatible-mode' };
    }

    // 经验规则：gptclub 的 /api 路径以 Messages 兼容模式承载多模型
    if (urlLower.includes('gptclubapi.xyz') && (pathname === '/api' || pathname.startsWith('/api/'))) {
      return { api: 'anthropic-messages', confidence: 'medium', reason: 'host:gptclubapi+path:/api' };
    }

    return null;
  }

  _resolveModelApi({ modelId, modelApi, providerApi, baseUrl }) {
    const normalizedModelApi = this._normalizeApiType(modelApi);
    const normalizedProviderApi = this._normalizeApiType(providerApi);
    const bySuffix = this._detectApiByBaseUrlSuffix(baseUrl);
    const byModelFamily = this._guessApiByModelId(modelId);

    // 1) baseUrl 明确指向具体 endpoint，直接采用
    if (bySuffix?.confidence === 'high') return bySuffix.api;

    // 2) OpenAI 官方域名下，GPT-5/Codex 默认优先 Responses
    if (byModelFamily === 'openai-responses' && this._isDirectOpenAIBaseUrl(baseUrl)) {
      return byModelFamily;
    }

    // 3) baseUrl 后缀提示（/openai /gemini /api 等）
    if (bySuffix) return bySuffix.api;

    // 4) 优先尊重模型级 API（支持同一 provider 下不同协议）
    if (normalizedModelApi) return normalizedModelApi;

    // 5) Provider 级 API 作为默认回退
    if (normalizedProviderApi) return normalizedProviderApi;

    // 6) 最后回退模型族推断
    if (byModelFamily) return byModelFamily;

    return this._detectApiType(baseUrl, modelId);
  }

  _migrateModelProtocolsInConfig() {
    try {
      const config = this._readConfig();
      const providers = config?.models?.providers;
      if (!providers || typeof providers !== 'object') return;

      let changed = false;

      for (const [, providerConfig] of Object.entries(providers)) {
        if (!Array.isArray(providerConfig.models)) continue;
        const resolvedProviderApi = this._normalizeApiType(providerConfig.api) || this._detectApiType(providerConfig.baseUrl, '');

        if (providerConfig.api !== resolvedProviderApi) {
          providerConfig.api = resolvedProviderApi;
          changed = true;
        }

        providerConfig.models = providerConfig.models.map((rawModel) => {
          const model = typeof rawModel === 'string'
            ? { id: rawModel, name: rawModel }
            : { ...(rawModel || {}) };

          if (!model.id) return rawModel;

          const resolvedApi = this._resolveModelApi({
            modelId: model.id,
            modelApi: model.api,
            providerApi: resolvedProviderApi,
            baseUrl: providerConfig.baseUrl
          });

          if (model.api !== resolvedApi) {
            model.api = resolvedApi;
            changed = true;
          }

          return model;
        });
      }

      if (changed) {
        this._saveConfig(config);
        this._loadConfig();
        this.switchLog.info('协议迁移', '已自动修正模型 API 协议映射');
      }
    } catch (err) {
      this.switchLog.warn('协议迁移失败', err.message);
    }
  }

  _getPrimaryModelId(config) {
    const modelField = config?.agents?.defaults?.model;
    if (typeof modelField === 'string') return modelField;
    if (modelField && typeof modelField === 'object') return modelField.primary || '';
    return '';
  }

  _setPrimaryModelId(config, modelId) {
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};

    const currentModelField = config.agents.defaults.model;
    if (currentModelField && typeof currentModelField === 'object' && !Array.isArray(currentModelField)) {
      config.agents.defaults.model.primary = modelId;
      return;
    }
    config.agents.defaults.model = modelId;
  }

  _loadConfig() {
    try {
      const SafeConfigLoader = require('./utils/safe-config-loader');
      const config = SafeConfigLoader.load(this.configPath, {});

      this.gatewayPort = config.gateway?.port || 18789;
      this.gatewayToken = config.gateway?.auth?.token || this.gatewayToken;
      this.gatewayDetector.setGatewayHost(`http://127.0.0.1:${this.gatewayPort}`);
      
      this.models = [];
      this.providers = {};
      this.providerOrder = [];
      this.currentModel = null;
      this.currentIndex = 0;
      const providers = config.models?.providers || {};
      
      for (const [providerName, providerConfig] of Object.entries(providers)) {
        this.providerOrder.push(providerName);
        
        // 尝试匹配预设以获取图标和颜色
        const preset = this._matchPreset(providerName, providerConfig.baseUrl);
        const resolvedProviderApi = this._normalizeApiType(providerConfig.api) || this._detectApiType(providerConfig.baseUrl, '');
        const pathMapping = providerConfig.pathMapping || preset?.pathMapping;

        this.providers[providerName] = {
          name: providerName,
          baseUrl: providerConfig.baseUrl || '',
          apiKey: providerConfig.apiKey || '',
          api: resolvedProviderApi,
          models: providerConfig.models || preset?.models || [],
          pathMapping: pathMapping,
          icon: preset?.icon || providerName.substring(0, 1).toUpperCase(),
          color: preset?.color || '#888888',
          website: preset?.website || '',
          description: preset?.description || '',
          features: preset?.features || [],
        };

        const modelList = (providerConfig.models || []).map((model) => (
          typeof model === 'string' ? { id: model, name: model } : model
        ));
        for (const model of modelList) {
          if (!model?.id) continue;
          // 模型级 baseURL：支持相对路径拼接和自动路径映射
          const modelBaseUrl = this._resolveModelBaseUrl(model.baseUrl, providerConfig.baseUrl, model.id, pathMapping);
          const resolvedApi = this._resolveModelApi({
            modelId: model.id,
            modelApi: model.api,
            providerApi: resolvedProviderApi,
            baseUrl: modelBaseUrl
          });
          this.models.push({
            id: `${providerName}/${model.id}`,
            name: model.name || model.id,
            shortName: this._getShortName(model.id, model.name),
            provider: providerName,
            providerBaseUrl: modelBaseUrl,
            modelId: model.id,
            api: resolvedApi,
            reasoning: model.reasoning || false,
            contextWindow: model.contextWindow || 200000,
            maxTokens: model.maxTokens || 32000,
            params: model.params || null,
            color: this._getModelColor(model.id),
            icon: this._getModelIcon(model.id),
          });
        }
      }
      
      // 获取当前默认模型
      const primaryModel = this._getPrimaryModelId(config);
      if (primaryModel) {
        this.currentIndex = this.models.findIndex(m => m.id === primaryModel);
        if (this.currentIndex === -1) this.currentIndex = 0;
        this.currentModel = this.models[this.currentIndex] || null;
      }
      
      const { colorLog } = require('./utils/color-log');
      colorLog(`🎯 ModelSwitcher V3: ${Object.keys(this.providers).length} providers, ${this.models.length} models, current: ${this.currentModel?.shortName || '?'}`);
      this.switchLog.info('配置加载', `${Object.keys(this.providers).length} providers, ${this.models.length} models, current: ${this.currentModel?.shortName || '?'}`);
    } catch (err) {
      console.error('❌ ModelSwitcher 配置加载失败:', err.message);
      this.switchLog.error('配置加载失败', err.message);
    }
  }

  /**
   * 根据 provider 名称或 baseUrl 匹配预设
   */
  _matchPreset(name, baseUrl) {
    const nameLower = name.toLowerCase();
    for (const [key, preset] of Object.entries(PROVIDER_PRESETS)) {
      if (nameLower.includes(key) || nameLower.includes(preset.name.toLowerCase())) {
        return preset;
      }
      try {
        if (baseUrl && preset.baseUrl && baseUrl.includes(new URL(preset.baseUrl).hostname)) {
          return preset;
        }
      } catch {}

    }
    
    // 通过 baseUrl 关键词匹配
    if (baseUrl) {
      if (baseUrl.includes('gptclubapi')) return PROVIDER_PRESETS['kkclaw'];
      if (baseUrl.includes('anthropic')) return PROVIDER_PRESETS['anthropic'];
      if (baseUrl.includes('openai.com')) return PROVIDER_PRESETS['openai'];
      if (baseUrl.includes('googleapis')) return PROVIDER_PRESETS['google'];
      if (baseUrl.includes('deepseek')) return PROVIDER_PRESETS['deepseek'];
      if (baseUrl.includes('openrouter')) return PROVIDER_PRESETS['openrouter'];
      if (baseUrl.includes('minimax')) return PROVIDER_PRESETS['minimax'];
      if (baseUrl.includes('bigmodel')) return PROVIDER_PRESETS['zhipu-glm'];
      if (baseUrl.includes('dashscope') || baseUrl.includes('aliyun')) return PROVIDER_PRESETS['qwen-coder'];
      if (baseUrl.includes('moonshot') || baseUrl.includes('kimi')) return PROVIDER_PRESETS['kimi'];
    }
    
    return null;
  }

  _saveConfig(config) {
    // 原子写入：先写临时文件再 rename
    const tmpPath = this.configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.configPath);
    // 热映射: 同步写入 models.json
    this._syncModelsJson(config);
  }

  _syncModelsJson(config) {
    try {
      const modelsPath = path.join(path.dirname(this.configPath), 'agents', 'main', 'agent', 'models.json');
      const providers = config.models?.providers || {};
      fs.mkdirSync(path.dirname(modelsPath), { recursive: true });
      fs.writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2), 'utf8');
    } catch (err) {
      console.warn('⚠️ models.json 同步失败:', err.message);
    }
  }

  _readConfig() {
    const SafeConfigLoader = require('./utils/safe-config-loader');
    return SafeConfigLoader.load(this.configPath, {});
  }

  // ==================== API 类型自动检测 ====================

  /**
   * 根据 baseUrl 与模型 ID 自动检测 API 类型
   * 优先级：显式后缀(/messages|/responses|/chat/completions) > 域名/路径特征 > 模型族回退
   */
  _detectApiType(baseUrl, modelId) {
    const url = (baseUrl || '').toLowerCase();
    const model = (modelId || '').toLowerCase();
    const bySuffix = this._detectApiByBaseUrlSuffix(baseUrl);
    if (bySuffix) return bySuffix.api;

    // Anthropic 官方或含 claude 的中转
    if (url.includes('anthropic')) return 'anthropic-messages';

    // 模型名判断 claude → anthropic
    if (model.includes('claude')) return 'anthropic-messages';

    // Codex / GPT-5+：仅在 OpenAI 官方域名优先 Responses，其余中转先走 Completions
    if (model.includes('codex') || model.includes('gpt-5')) {
      return this._isDirectOpenAIBaseUrl(baseUrl) ? 'openai-responses' : 'openai-completions';
    }

    // baseUrl 路径含 /responses
    if (url.includes('/responses')) return 'openai-responses';

    // 默认 OpenAI Completions
    if (url.includes('openai') || url.includes('openrouter') || url.includes('deepseek') ||
        url.includes('dashscope') || url.includes('bigmodel') || url.includes('moonshot') ||
        url.includes('minimax') || url.includes('googleapis')) {
      return 'openai-completions';
    }

    return 'anthropic-messages';
  }

  // ==================== Provider 管理 ====================

  /**
   * 从 cc-switch 同步 providers
   */
  syncFromCCSwitch() {
    try {
      const providers = ccSwitchSync.syncProviders();
      let syncCount = 0;

      for (const provider of providers) {
        try {
          this.addProvider(provider.name, {
            baseUrl: provider.baseURL,
            apiKey: provider.apiKey,
            models: provider.models
          });
          syncCount++;
        } catch (e) {
          // Provider已存在，跳过
          if (!e.message.includes('already exists')) {
            console.warn(`同步provider失败: ${provider.name}`, e.message);
          }
        }
      }

      if (syncCount > 0) {
        console.log(`✅ 从 cc-switch 同步了 ${syncCount} 个 providers`);
      }
    } catch (error) {
      console.warn('cc-switch 同步失败:', error.message);
    }
  }

  addProvider(name, opts = {}) {
    const config = this._readConfig();
    if (!config.models) config.models = { mode: 'merge', providers: {} };
    if (!config.models.providers) config.models.providers = {};

    const normalizedOpts = { ...(opts || {}) };
    if (normalizedOpts.baseUrl === undefined && typeof normalizedOpts.baseURL === 'string') {
      normalizedOpts.baseUrl = normalizedOpts.baseURL;
    }
    
    if (config.models.providers[name]) {
      throw new Error(`Provider "${name}" already exists. Use updateProvider() to modify.`);
    }

    // Avoid case-insensitive collisions (some consumers treat provider keys as case-insensitive).
    const existing = Object.keys(config.models.providers).find(k => k.toLowerCase() === String(name).toLowerCase());
    if (existing) {
      throw new Error(`Provider "${name}" conflicts with existing "${existing}" (case-insensitive). Please rename.`);
    }

    const detectedApi = this._normalizeApiType(normalizedOpts.api) || this._detectApiType(normalizedOpts.baseUrl, '');
    const inputModels = (normalizedOpts.models || []).map((model) => (
      typeof model === 'string' ? { id: model, name: model } : model
    ));
    const provider = {
      baseUrl: normalizedOpts.baseUrl || '',
      apiKey: normalizedOpts.apiKey || '',
      api: detectedApi,
      models: inputModels.map(m => ({
        id: m.id,
        name: m.name || m.id,
        api: this._resolveModelApi({
          modelId: m.id,
          modelApi: m.api,
          providerApi: detectedApi,
          baseUrl: normalizedOpts.baseUrl
        }),
        reasoning: m.reasoning || false,
        input: m.input || ['text', 'image'],
        cost: m.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: m.contextWindow || 200000,
        maxTokens: m.maxTokens || 32000,
      }))
    };

    config.models.providers[name] = provider;
    
    if (!config.agents) config.agents = { defaults: {} };
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.models) config.agents.defaults.models = {};
    for (const m of provider.models) {
      const modelEntry = {};
      if (m.params) modelEntry.params = m.params;
      config.agents.defaults.models[`${name}/${m.id}`] = modelEntry;
    }

    this._saveConfig(config);
    this._loadConfig();
    this._notifyListeners();

    console.log(`✅ Provider added: ${name} (${provider.models.length} models)`);
    this.switchLog.success('添加 Provider', `${name} (${provider.models.length} models, api: ${detectedApi})`);
    return provider;
  }

  addFromPreset(presetKey, apiKey, customName = null, customBaseUrl = null) {
    const preset = PROVIDER_PRESETS[presetKey];
    if (!preset) {
      throw new Error(`Unknown preset: ${presetKey}. Available: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
    }

    const name = customName || preset.name;
    const baseUrl = customBaseUrl || preset.baseUrl;

    return this.addProvider(name, {
      baseUrl,
      apiKey,
      api: preset.api,
      models: preset.models,
    });
  }

  updateProvider(name, updates = {}) {
    const config = this._readConfig();
    const provider = config.models?.providers?.[name];
    if (!provider) throw new Error(`Provider "${name}" not found`);

    const normalizedUpdates = { ...(updates || {}) };
    if (normalizedUpdates.baseUrl === undefined && typeof normalizedUpdates.baseURL === 'string') {
      normalizedUpdates.baseUrl = normalizedUpdates.baseURL;
    }

    if (normalizedUpdates.baseUrl !== undefined) provider.baseUrl = normalizedUpdates.baseUrl;
    if (normalizedUpdates.apiKey !== undefined) provider.apiKey = normalizedUpdates.apiKey;
    if (normalizedUpdates.api !== undefined) provider.api = normalizedUpdates.api;

    if (normalizedUpdates.baseUrl !== undefined || normalizedUpdates.api !== undefined) {
      const resolvedProviderApi = this._normalizeApiType(provider.api) || this._detectApiType(provider.baseUrl, '');
      provider.api = resolvedProviderApi;

      provider.models = (provider.models || []).map((rawModel) => {
        const model = typeof rawModel === 'string'
          ? { id: rawModel, name: rawModel }
          : { ...(rawModel || {}) };
        if (!model.id) return rawModel;

        model.api = this._resolveModelApi({
          modelId: model.id,
          modelApi: model.api,
          providerApi: resolvedProviderApi,
          baseUrl: provider.baseUrl
        });
        return model;
      });
    }

    this._saveConfig(config);
    this._loadConfig();
    this._notifyListeners();

    console.log(`✅ Provider updated: ${name}`);
    this.switchLog.info('更新 Provider', `${name} | ${JSON.stringify(normalizedUpdates)}`);
    return provider;
  }

  removeProvider(name) {
    const config = this._readConfig();
    if (!config.models?.providers?.[name]) {
      throw new Error(`Provider "${name}" not found`);
    }

    delete config.models.providers[name];

    if (config.agents?.defaults?.models) {
      for (const key of Object.keys(config.agents.defaults.models)) {
        if (key.startsWith(`${name}/`)) {
          delete config.agents.defaults.models[key];
        }
      }
    }

    const primaryModelId = this._getPrimaryModelId(config);
    if (primaryModelId?.startsWith(`${name}/`)) {
      const remaining = Object.keys(config.models.providers);
      if (remaining.length > 0) {
        const firstProvider = config.models.providers[remaining[0]];
        if (firstProvider.models?.length > 0) {
          this._setPrimaryModelId(config, `${remaining[0]}/${firstProvider.models[0].id}`);
        }
      } else {
        this._setPrimaryModelId(config, '');
      }
    }

    this._saveConfig(config);
    this._loadConfig();
    this._notifyListeners();

    console.log(`✅ Provider removed: ${name}`);
    this.switchLog.warn('删除 Provider', name);
  }

  getProviders() {
    return Object.entries(this.providers).map(([name, p]) => ({
      name,
      baseUrl: p.baseUrl,
      api: p.api,
      apiType: API_TYPES[p.api]?.label || p.api,
      modelCount: p.models.length,
      hasApiKey: !!p.apiKey,
      icon: p.icon,
      color: p.color,
      website: p.website,
      features: p.features || [],
      description: p.description,
      isCurrent: this.currentModel?.provider === name,
      speedTest: this.speedTestResults[name] || null,
    }));
  }

  getPresets() {
    return Object.entries(PROVIDER_PRESETS).map(([key, preset]) => ({
      key,
      name: preset.name,
      baseUrl: preset.baseUrl,
      api: preset.api,
      icon: preset.icon,
      color: preset.color,
      website: preset.website,
      description: preset.description,
      modelCount: preset.models.length,
      models: preset.models.map(m => m.name),
    }));
  }

  // ==================== 测速功能 ====================

  /**
   * 测试 Provider API 延迟
   * @param {string} providerName - Provider 名称
   * @returns {Promise<{latencyMs: number, status: string}>}
   */
  async speedTest(providerName) {
    const provider = this.providers[providerName];
    if (!provider || !provider.baseUrl) {
      return { latencyMs: -1, status: 'error', error: 'No base URL configured' };
    }

    const startTime = Date.now();
    
    try {
      // 简单的 HTTP HEAD/GET 请求测延迟
      const url = new URL(provider.baseUrl);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      // 构建 /v1/models 请求路径（与 fetchModels 保持一致）
      let testPath = url.pathname;
      if (testPath.endsWith('/')) testPath = testPath.slice(0, -1);
      if (/\/v\d+/.test(testPath)) testPath += '/models';
      else testPath += '/v1/models';

      await new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        // Anthropic 用 x-api-key，OpenAI 兼容用 Authorization Bearer
        if (provider.api === 'anthropic-messages') {
          headers['x-api-key'] = provider.apiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else {
          headers['Authorization'] = `Bearer ${provider.apiKey}`;
        }

        const req = httpModule.request({
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: testPath,
          method: 'GET',
          headers,
          timeout: 10000,
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ statusCode: res.statusCode }));
        });
        
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });
      
      const latencyMs = Date.now() - startTime;
      let quality = 'fast';
      if (latencyMs > 3000) quality = 'slow';
      else if (latencyMs > 1000) quality = 'medium';
      
      const result = { latencyMs, status: 'ok', quality, timestamp: Date.now() };
      this.speedTestResults[providerName] = result;
      
      console.log(`⏱️ Speed test ${providerName}: ${latencyMs}ms (${quality})`);
      this.switchLog.info('测速', `${providerName}: ${latencyMs}ms (${quality})`);
      return result;
    } catch (err) {
      const result = { latencyMs: -1, status: 'error', error: err.message, timestamp: Date.now() };
      this.speedTestResults[providerName] = result;
      this.switchLog.error('测速失败', `${providerName}: ${err.message}`);
      return result;
    }
  }

  /**
   * 测试所有 Provider
   */
  async speedTestAll() {
    const results = {};
    for (const name of Object.keys(this.providers)) {
      results[name] = await this.speedTest(name);
    }
    return results;
  }

  _buildApiRequestPath(basePath, endpointSuffix) {
    const endpoint = String(endpointSuffix || '').replace(/^\/+/, '');
    let pathName = String(basePath || '/');
    if (!pathName.startsWith('/')) pathName = `/${pathName}`;
    pathName = pathName.replace(/\/+$/, '');

    if (!pathName || pathName === '/') return `/v1/${endpoint}`;
    if (pathName.endsWith(`/${endpoint}`)) return pathName;
    if (/\/v\d+(?:[a-z0-9_-]+)?$/i.test(pathName)) return `${pathName}/${endpoint}`;
    return `${pathName}/v1/${endpoint}`;
  }

  _pickProbeModelId(provider, apiType) {
    const list = (provider?.models || []).map((raw) => (
      typeof raw === 'string' ? { id: raw } : (raw || {})
    )).filter((m) => m.id);
    const findBy = (predicate) => list.find((m) => predicate(String(m.id).toLowerCase()));

    if (apiType === 'anthropic-messages') {
      return findBy(id => id.includes('claude'))?.id || 'claude-sonnet-4-6';
    }
    if (apiType === 'openai-responses') {
      return findBy(id => id.includes('codex') || id.startsWith('gpt-5'))?.id || 'gpt-5.2';
    }
    return findBy(id => id.includes('gpt'))?.id || findBy(id => id.includes('gemini'))?.id || 'gpt-4o';
  }

  _classifyProbeResponse(statusCode, bodyText) {
    const text = String(bodyText || '').toLowerCase();

    if (statusCode >= 200 && statusCode < 300) {
      return { connectable: true, routeFound: true, verdict: 'ok' };
    }

    if (statusCode === 404) {
      if (text.includes('route') && text.includes('not found')) {
        return { connectable: false, routeFound: false, verdict: 'route_not_found' };
      }
      if (text.includes('invalid url')) {
        return { connectable: true, routeFound: true, verdict: 'upstream_path_invalid' };
      }
      return { connectable: true, routeFound: true, verdict: 'not_found' };
    }

    if ([400, 401, 403, 405, 409, 415, 422, 429].includes(statusCode)) {
      return { connectable: true, routeFound: true, verdict: 'protocol_reachable_request_rejected' };
    }

    if (statusCode >= 500) {
      if (text.includes('model') || text.includes('no available') || text.includes('unsupported') || text.includes('account')) {
        return { connectable: true, routeFound: true, verdict: 'protocol_ok_model_or_pool_unavailable' };
      }
      return { connectable: true, routeFound: true, verdict: 'protocol_reachable_server_error' };
    }

    return { connectable: true, routeFound: true, verdict: 'unknown' };
  }

  async _probeOneApi(provider, apiType, timeoutMs = 12000) {
    const providerUrl = new URL(provider.baseUrl);
    const endpointSuffix = apiType === 'anthropic-messages'
      ? 'messages'
      : apiType === 'openai-responses'
        ? 'responses'
        : 'chat/completions';
    const requestPath = this._buildApiRequestPath(providerUrl.pathname, endpointSuffix);
    const endpoint = `${providerUrl.protocol}//${providerUrl.host}${requestPath}`;
    const modelId = this._pickProbeModelId(provider, apiType);

    const headers = { 'Content-Type': 'application/json' };
    if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
    if (apiType === 'anthropic-messages') {
      if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    }

    const payload = apiType === 'anthropic-messages'
      ? { model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
      : apiType === 'openai-responses'
        ? { model: modelId, input: 'ping', max_output_tokens: 1 }
        : { model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false };

    const started = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const text = await response.text().catch(() => '');
      const classified = this._classifyProbeResponse(response.status, text);
      return {
        apiType,
        endpoint,
        modelId,
        status: response.status,
        elapsedMs: Date.now() - started,
        ...classified,
        bodyPreview: text.slice(0, 220)
      };
    } catch (err) {
      return {
        apiType,
        endpoint,
        modelId,
        status: null,
        elapsedMs: Date.now() - started,
        connectable: false,
        routeFound: false,
        verdict: 'request_error',
        error: err.message
      };
    }
  }

  async probeProviderConnectivity(providerName, options = {}) {
    const provider = this.providers[providerName];
    if (!provider) return { success: false, error: `Provider "${providerName}" not found` };
    if (!provider.baseUrl) return { success: false, error: 'No base URL configured' };

    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 12000;
    const apiTypes = ['anthropic-messages', 'openai-completions', 'openai-responses'];
    const tests = [];

    for (const apiType of apiTypes) {
      tests.push(await this._probeOneApi(provider, apiType, timeoutMs));
    }

    const suffixHint = this._detectApiByBaseUrlSuffix(provider.baseUrl);
    const providerApi = this._normalizeApiType(provider.api) || null;
    const reachableApis = tests.filter(t => t.connectable).map(t => t.apiType);
    const routeFoundApis = tests.filter(t => t.routeFound).map(t => t.apiType);

    let recommendedApi = null;
    let reason = '';
    if (suffixHint?.api && routeFoundApis.includes(suffixHint.api)) {
      recommendedApi = suffixHint.api;
      reason = `baseUrl 后缀规则: ${suffixHint.reason}`;
    } else if (providerApi && routeFoundApis.includes(providerApi)) {
      recommendedApi = providerApi;
      reason = 'provider.api 与探测结果一致';
    } else if (routeFoundApis.length > 0) {
      recommendedApi = routeFoundApis[0];
      reason = '按探测可用性回退';
    }

    const resolvedModels = (provider.models || []).map((raw) => (
      typeof raw === 'string' ? { id: raw, api: null } : (raw || {})
    )).filter((m) => m.id).slice(0, 30).map((m) => ({
      id: m.id,
      api: this._resolveModelApi({
        modelId: m.id,
        modelApi: m.api,
        providerApi: providerApi || recommendedApi,
        baseUrl: provider.baseUrl
      })
    }));

    return {
      success: true,
      providerName,
      baseUrl: provider.baseUrl,
      providerApi,
      suffixHint: suffixHint || null,
      recommendedApi,
      reason,
      summary: {
        routeFoundApis,
        reachableApis,
        allPass: tests.every(t => t.connectable)
      },
      tests,
      resolvedModels
    };
  }

  // ==================== 远程获取模型列表 ====================

  async fetchModels(providerName) {
    const provider = this.providers[providerName];
    if (!provider || !provider.baseUrl) {
      return { success: false, error: 'No base URL configured' };
    }

    try {
      const url = new URL(provider.baseUrl);
      const isHttps = url.protocol === 'https:';
      const httpModule = isHttps ? https : http;

      // 构建 /v1/models 请求路径
      let modelsPath = url.pathname;
      if (modelsPath.endsWith('/')) modelsPath = modelsPath.slice(0, -1);
      // 如果路径已经包含版本号如 /v1，直接加 /models
      if (/\/v\d+/.test(modelsPath)) {
        modelsPath += '/models';
      } else {
        modelsPath += '/v1/models';
      }

      const data = await new Promise((resolve, reject) => {
        const headers = { 'Content-Type': 'application/json' };
        // Anthropic 用 x-api-key，OpenAI 兼容用 Authorization Bearer
        if (provider.api === 'anthropic-messages') {
          headers['x-api-key'] = provider.apiKey;
          headers['anthropic-version'] = '2023-06-01';
        } else {
          headers['Authorization'] = `Bearer ${provider.apiKey}`;
        }

        const req = httpModule.request({
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: modelsPath,
          method: 'GET',
          headers,
          timeout: 15000,
        }, (res) => {
          let body = '';
          res.on('data', chunk => body += chunk);
          res.on('end', () => {
            try { resolve({ statusCode: res.statusCode, body: JSON.parse(body) }); }
            catch { resolve({ statusCode: res.statusCode, body }); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
      });

      if (data.statusCode !== 200) {
        return { success: false, error: `HTTP ${data.statusCode}` };
      }

      // 解析模型列表（兼容 OpenAI / Anthropic / Gemini / OpenRouter 格式）
      let models = [];
      const body = data.body;

      if (body.data && Array.isArray(body.data)) {
        // OpenAI / Anthropic / OpenRouter 格式: { data: [...] }
        models = body.data.map(m => {
          const model = {
            id: m.id,
            name: m.display_name || m.name || m.id,
          };
          // OpenRouter 返回丰富元数据
          if (m.context_length) model.contextWindow = m.context_length;
          if (m.top_provider?.max_completion_tokens) model.maxTokens = m.top_provider.max_completion_tokens;
          if (m.supported_parameters?.includes('reasoning')) {
            model.reasoning = true;
            model.params = { reasoning_effort: 'high' };
          }
          return model;
        });
      } else if (body.models && Array.isArray(body.models)) {
        // Google Gemini 格式: { models: [...] }
        models = body.models.map(m => {
          const model = {
            id: (m.name || '').replace('models/', ''),
            name: m.displayName || m.name,
          };
          if (m.inputTokenLimit) model.contextWindow = m.inputTokenLimit;
          if (m.outputTokenLimit) model.maxTokens = m.outputTokenLimit;
          if (m.thinking) model.reasoning = true;
          return model;
        });
      } else if (Array.isArray(body)) {
        models = body.map(m => ({
          id: m.id || m.model,
          name: m.name || m.display_name || m.id || m.model,
        }));
      }

      // 用已知模型元数据补全 API 未返回的字段
      models = models.map(m => this._enrichModelMeta(m));

      console.log(`📡 ${providerName}: 获取到 ${models.length} 个模型`);
      this.switchLog.info('获取模型列表', `${providerName}: ${models.length} 个模型`);
      return { success: true, models };
    } catch (err) {
      console.error(`❌ 获取模型失败 ${providerName}:`, err.message);
      this.switchLog.error('获取模型失败', `${providerName}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  // ==================== Model 管理 ====================

  addModel(providerName, model) {
    const config = this._readConfig();
    const provider = config.models?.providers?.[providerName];
    if (!provider) throw new Error(`Provider "${providerName}" not found`);

    provider.models = provider.models || [];
    
    if (provider.models.find(m => m.id === model.id)) {
      throw new Error(`Model "${model.id}" already exists in provider "${providerName}"`);
    }

    const resolvedApi = this._resolveModelApi({
      modelId: model.id,
      modelApi: model.api,
      providerApi: provider.api,
      baseUrl: provider.baseUrl
    });

    const modelEntry = {
      id: model.id,
      name: model.name || model.id,
      api: resolvedApi,
      reasoning: model.reasoning || false,
      input: model.input || ['text', 'image'],
      cost: model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow || 200000,
      maxTokens: model.maxTokens || 32000,
    };
    if (model.params) modelEntry.params = model.params;
    if (model.baseUrl) modelEntry.baseUrl = model.baseUrl;
    provider.models.push(modelEntry);

    if (!config.agents) config.agents = { defaults: {} };
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.models) config.agents.defaults.models = {};
    const agentModelEntry = {};
    if (model.params) agentModelEntry.params = model.params;
    config.agents.defaults.models[`${providerName}/${model.id}`] = agentModelEntry;

    this._saveConfig(config);
    this._loadConfig();
    this._notifyListeners();

    console.log(`✅ Model added: ${providerName}/${model.id}`);
    this.switchLog.success('添加模型', `${providerName}/${model.id}`);
  }

  removeModel(providerName, modelId) {
    const config = this._readConfig();
    const provider = config.models?.providers?.[providerName];
    if (!provider) throw new Error(`Provider "${providerName}" not found`);

    provider.models = (provider.models || []).filter(m => m.id !== modelId);

    if (config.agents?.defaults?.models) {
      delete config.agents.defaults.models[`${providerName}/${modelId}`];
    }

    // 如果删除的是默认模型，回退到第一个可用模型，避免 primary 指向不存在的模型
    const removedFullId = `${providerName}/${modelId}`;
    if (this._getPrimaryModelId(config) === removedFullId) {
      const providers = config.models?.providers || {};
      let nextPrimary = null;
      for (const [pName, pCfg] of Object.entries(providers)) {
        const first = (pCfg.models || [])[0];
        if (first?.id) {
          nextPrimary = `${pName}/${first.id}`;
          break;
        }
      }
      if (nextPrimary) {
        this._setPrimaryModelId(config, nextPrimary);
      }
    }

    this._saveConfig(config);
    this._loadConfig();
    this._notifyListeners();

    console.log(`✅ Model removed: ${providerName}/${modelId}`);
    this.switchLog.warn('删除模型', `${providerName}/${modelId}`);
  }

  // ==================== 模型切换 ====================

  getModels() { return this.models; }
  getCurrent() { return this.currentModel; }

  async next() {
    if (this.models.length <= 1) return this.currentModel;
    this.currentIndex = (this.currentIndex + 1) % this.models.length;
    return this._applySwitch();
  }

  async prev() {
    if (this.models.length <= 1) return this.currentModel;
    this.currentIndex = (this.currentIndex - 1 + this.models.length) % this.models.length;
    return this._applySwitch();
  }

  async switchToProvider(providerName) {
    const provider = this.providers[providerName];
    if (!provider) {
      this._setLastSwitchResult({
        success: false,
        error: 'provider_not_found',
        requestedProvider: providerName,
        resolvedApi: null,
        model: this.currentModel || null
      });
      return null;
    }

    // 如果该服务商没有模型，自动补上标准模型
    const providerModels = this.models.filter(m => m.provider === providerName);
    if (providerModels.length === 0) {
      const api = provider?.api || 'anthropic-messages';
      let stdModels;
      if (api === 'openai-responses') {
        stdModels = [
          { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex' },
          { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
          { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
        ];
      } else if (api === 'openai-completions') {
        stdModels = [
          { id: 'gpt-5.2', name: 'GPT-5.2' },
          { id: 'gpt-5.1', name: 'GPT-5.1' },
          { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash' },
        ];
      } else {
        stdModels = [
          { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
        ];
      }
      for (const m of stdModels) {
        this.addModel(providerName, m);
      }
    }
    const firstModel = this.models.find(m => m.provider === providerName);
    if (!firstModel) {
      console.error(`❌ 服务商 ${providerName} 无可用模型`);
      this._setLastSwitchResult({
        success: false,
        error: 'provider_no_models',
        requestedProvider: providerName,
        resolvedApi: this.providers[providerName]?.api || null,
        model: this.currentModel || null,
      });
      return null;
    }
    return this.switchTo(firstModel.id);
  }

  async switchTo(modelId) {
    const idx = this.models.findIndex(m => m.id === modelId || m.modelId === modelId);
    if (idx === -1) {
      console.error(`❌ 未找到模型: ${modelId}`);
      this._setLastSwitchResult({
        success: false,
        error: 'model_not_found',
        requestedModelId: modelId,
        resolvedApi: null,
        model: this.currentModel || null,
      });
      return null;
    }

    const targetModel = this.models[idx];
    if (this.currentModel?.id === targetModel.id) {
      this._setLastSwitchResult({
        success: true,
        error: null,
        requestedModelId: targetModel.id,
        previousModelId: this.currentModel.id,
        resolvedApi: this.currentModel?.api || null,
        model: this.currentModel,
        duration: 0,
        strategy: 'noop',
        noOp: true
      });
      return this.currentModel;
    }

    this.currentIndex = idx;
    return this._applySwitch();
  }

  async _applySwitch() {
    const targetModel = this.models[this.currentIndex];
    const previousModel = this.currentModel;
    const startTime = Date.now();

    // 防止并发切换
    if (this.stateMachine.isSwitching()) {
      console.warn('⚠️ 切换进行中，请稍候');
      this._setLastSwitchResult({
        success: false,
        error: 'switch_in_progress',
        requestedModelId: targetModel?.id || null,
        previousModelId: previousModel?.id || null,
        resolvedApi: targetModel?.api || null,
        model: this.currentModel || null
      });
      return this.currentModel;
    }

    console.log(`🔄 开始切换模型: ${previousModel?.shortName || '(none)'} → ${targetModel.shortName}`);
    this.switchLog.info('开始切换', `${previousModel?.shortName || '(none)'} → ${targetModel.shortName}`);

    try {
      // 状态：准备中
      await this.stateMachine.transition(SwitchState.PREPARING, {
        targetModel,
        previousModel,
        startTime
      });

      // 乐观更新 UI
      this.currentModel = targetModel;
      this._notifyListeners();

      // 状态：切换中（写配置）
      await this.stateMachine.transition(SwitchState.SWITCHING);

      const strategy = getStrategy(this.switchStrategy);
      const result = await strategy.execute(targetModel, previousModel, this);

      if (!result.success) {
        throw new Error(result.reason || 'Strategy execution failed');
      }

      // 状态：验证中
      await this.stateMachine.transition(SwitchState.VALIDATING);

      // 快速验证（仅安全模式）
      if (result.mode === 'safe') {
        const verified = await this.verifyConfig(targetModel.id);
        if (!verified) {
          throw new Error('验证失败');
        }
      }

      // 状态：同步中（异步清理 session）
      await this.stateMachine.transition(SwitchState.SYNCING);
      this._clearSessionsAsync();

      // 状态：完成
      await this.stateMachine.transition(SwitchState.COMPLETED);

      const duration = Date.now() - startTime;
      console.log(`✅ 模型切换成功: ${targetModel.shortName} (${duration}ms, ${result.mode})`);
      this.switchLog.success('切换成功', `${targetModel.shortName} (${duration}ms, ${result.mode})`);
      if (result.warning) {
        this.switchLog.warn('切换警告', result.warning);
      }

      // 记录历史
      this.switchHistory.record({
        targetModel,
        previousModel,
        success: true,
        duration,
        strategy: result.mode
      });

      this._setLastSwitchResult({
        success: true,
        error: null,
        requestedModelId: targetModel.id,
        previousModelId: previousModel?.id || null,
        resolvedApi: targetModel.api || null,
        providerApi: this.providers[targetModel.provider]?.api || null,
        warning: result.warning || null,
        model: this.currentModel,
        duration,
        strategy: result.mode
      });

      this.stateMachine.reset();
      return this.currentModel;

    } catch (err) {
      console.error(`❌ 模型切换失败:`, err.message);
      this.switchLog.error('切换失败', err.message);

      await this.stateMachine.transition(SwitchState.FAILED, { error: err.message });

      // 回滚
      await this._rollbackModel(previousModel, this.models.findIndex(m => m.id === previousModel?.id));

      // 记录失败历史
      this.switchHistory.record({
        targetModel,
        previousModel,
        success: false,
        duration: Date.now() - startTime,
        strategy: this.switchStrategy,
        error: err.message
      });

      this._setLastSwitchResult({
        success: false,
        error: err.message,
        requestedModelId: targetModel?.id || null,
        previousModelId: previousModel?.id || null,
        resolvedApi: targetModel?.api || null,
        providerApi: targetModel?.provider ? (this.providers[targetModel.provider]?.api || null) : null,
        model: previousModel || this.currentModel || null,
        duration: Date.now() - startTime,
        strategy: this.switchStrategy
      });

      this.stateMachine.reset();
      return previousModel;
    }
  }

  /**
   * 安全地写入配置文件（带错误处理）
   */
  async _writeModelToConfigSafe(modelId, previousModelId) {
    try {
      const config = this._readConfig();

      // 确保路径存在
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      this._setPrimaryModelId(config, modelId);

      // 同步模型的 params
      if (!config.agents.defaults.models) config.agents.defaults.models = {};
      const model = this.models.find(m => m.id === modelId);
      if (model && model.params) {
        config.agents.defaults.models[modelId] = {
          ...(config.agents.defaults.models[modelId] || {}),
          params: model.params
        };
      }

      // 原子写入
      const tmpPath = this.configPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.configPath);

      // 同步 models.json
      this._syncModelsJson(config);

      console.log(`✅ 配置已更新: ${previousModelId || '(none)'} → ${modelId}`);
      this.switchLog.info('配置写入', `${previousModelId || '(none)'} → ${modelId}`);

      return true;
    } catch (err) {
      console.error(`❌ 写入配置失败:`, err.message);
      this.switchLog.error('配置写入失败', err.message);
      return false;
    }
  }

  // ==================== 策略接口方法 ====================

  /**
   * 供策略调用：更新当前模型
   */
  updateCurrentModel(model) {
    this.currentModel = model;
    this._notifyListeners();
  }

  /**
   * 供策略调用：同步写配置
   */
  async writeConfig(targetModel) {
    const previousModelId = this.stateMachine.getContext()?.previousModel?.id || this.currentModel?.id;
    return this._writeModelToConfigSafe(targetModel.id, previousModelId);
  }

  /**
   * 供策略调用：异步写配置
   */
  async writeConfigAsync(targetModel) {
    const previousModelId = this.stateMachine.getContext()?.previousModel?.id || this.currentModel?.id;
    return this._writeModelToConfigSafe(targetModel.id, previousModelId);
  }

  /**
   * 供策略调用：快速检查 Gateway
   */
  async quickCheckGateway(timeoutMs = 2000) {
    return this.gatewayDetector.quickCheck(timeoutMs);
  }

  /**
   * 供策略调用：等待 Gateway 就绪（用于避免短暂重载误判）
   */
  async waitForGatewayReady(timeoutMs = 7000) {
    return this.gatewayDetector.waitReady(timeoutMs);
  }

  /**
   * 供策略调用：验证配置
   */
  async verifyConfig(expectedModelId) {
    try {
      const config = this._readConfig();
      const actualModelId = this._getPrimaryModelId(config);

      if (actualModelId !== expectedModelId) {
        console.error(`❌ 配置验证失败: 期望 ${expectedModelId}, 实际 ${actualModelId}`);
        return false;
      }

      console.log(`✅ 配置验证成功: ${actualModelId}`);
      return true;
    } catch (err) {
      console.error(`❌ 验证失败:`, err.message);
      return false;
    }
  }

  /**
   * 供策略调用：获取切换历史
   */
  getSwitchHistory() {
    return this.switchHistory;
  }

  /**
   * 状态变化回调
   */
  _onStateChange(event) {
    // 通知所有监听器状态变化
    for (const listener of this.listeners) {
      if (typeof listener === 'function') {
        listener({
          type: 'switch-state',
          state: event.to,
          progress: event.progress,
          context: event.context
        });
      }
    }
  }

  /**
   * 获取切换状态
   */
  getSwitchState() {
    return {
      state: this.stateMachine.getState(),
      progress: this.stateMachine.getProgress(),
      context: this.stateMachine.getContext(),
      isSwitching: this.stateMachine.isSwitching()
    };
  }

  /**
   * 设置切换策略
   */
  setSwitchStrategy(strategy) {
    if (['fast', 'safe', 'smart'].includes(strategy)) {
      this.switchStrategy = strategy;
      console.log(`🔧 切换策略已设置: ${strategy}`);
    }
  }

  /**
   * 获取切换统计
   */
  getSwitchStats() {
    return {
      strategy: this.switchStrategy,
      history: this.switchHistory.getRecent(10),
      state: this.getSwitchState()
    };
  }

  /**
   * 等待 Gateway 重新加载配置（优化版）
   */
  async _waitForGatewayReload(timeoutMs = 3000) {
    return this.gatewayDetector.waitReady(timeoutMs);
  }

  /**
   * 验证模型是否切换成功（优化版）
   */
  async _verifyModelSwitch(expectedModelId) {
    return this.verifyConfig(expectedModelId);
  }

  /**
   * 回滚到之前的模型
   */
  async _rollbackModel(previousModel, previousIndex) {
    if (!previousModel) {
      console.warn(`⚠️ 无法回滚：没有之前的模型`);
      return;
    }

    console.log(`🔙 回滚到之前的模型: ${previousModel.shortName}`);
    this.switchLog.warn('回滚', `恢复到 ${previousModel.shortName}`);

    this.currentModel = previousModel;
    this.currentIndex = previousIndex >= 0 ? previousIndex : 0;

    // 写回配置文件
    await this._writeModelToConfigSafe(previousModel.id, null);

    // 通知监听器
    this._notifyListeners();
  }

  _isPluginSessionKey(sessionKey) {
    return SessionLockManager.isPluginSessionKey(sessionKey);
  }

  /**
   * 安全地清理聊天插件 session（改进版 - 同步）
   */
  _clearLarkSessionsSafe() {
    try {
      const result = SessionLockManager.cleanupPluginSessions({
        agentId: 'main',
        removeIndex: true,
        force: false,
        lockStaleMs: 120000
      });

      if (result.deletedSessions > 0 || result.removedLocks > 0) {
        console.log(`✅ 已清理 ${result.deletedSessions} 个会话，移除 ${result.removedLocks} 个僵尸锁`);
        this.switchLog.info('Session 清理', `删除 ${result.deletedSessions} 个插件会话`);
      }
      if (result.skippedLocked > 0) {
        this.switchLog.warn('Session 清理', `跳过 ${result.skippedLocked} 个活跃锁会话`);
      }
    } catch (err) {
      console.error(`⚠️ 清理插件 session 失败:`, err.message);
      this.switchLog.warn('Session 清理失败', err.message);
    }
  }

  /**
   * 异步清理 session（不阻塞切换）
   */
  _clearSessionsAsync() {
    setImmediate(async () => {
      try {
        let lastResult = null;
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          lastResult = SessionLockManager.cleanupPluginSessions({
            agentId: 'main',
            removeIndex: true,
            force: false,
            lockStaleMs: 120000
          });

          if (!lastResult || lastResult.skippedLocked === 0) {
            break;
          }

          if (attempt < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 800));
          }
        }

        if (lastResult && (lastResult.deletedSessions > 0 || lastResult.removedLocks > 0)) {
          console.log(`🧹 后台清理完成: ${lastResult.deletedSessions} 个 session，${lastResult.removedLocks} 个僵尸锁`);
        }
        if (lastResult && lastResult.skippedLocked > 0) {
          console.warn(`⚠️ 后台清理跳过 ${lastResult.skippedLocked} 个活跃锁 session`);
        }
      } catch (err) {
        console.warn('后台 session 清理失败:', err.message);
      }
    });
  }

  _writeModelToConfig(modelId) {
    try {
      const config = this._readConfig();

      // 确保路径存在
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      const previousModel = this._getPrimaryModelId(config);
      this._setPrimaryModelId(config, modelId);

      // 同步模型的 params（如 reasoning_effort）到 agents.defaults.models
      if (!config.agents.defaults.models) config.agents.defaults.models = {};
      const model = this.models.find(m => m.id === modelId);
      if (model && model.params) {
        config.agents.defaults.models[modelId] = {
          ...(config.agents.defaults.models[modelId] || {}),
          params: model.params
        };
      }

      // 原子写入：先写临时文件再 rename，防止写入中断导致配置损坏
      const tmpPath = this.configPath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.configPath);

      // 同步 models.json
      this._syncModelsJson(config);

      console.log(`✅ openclaw.json 已更新: ${previousModel || '(none)'} → ${modelId}`);
      if (model?.params) {
        console.log(`   params: ${JSON.stringify(model.params)}`);
      }
      this.switchLog.info('配置写入', `${previousModel || '(none)'} → ${modelId} (Gateway file watcher 热加载)`);

      // 清理聊天插件 session，迫使 Gateway 用新模型重建对话
      this._clearLarkSessions();

      // 重新加载内存状态
      this._loadConfig();
    } catch (err) {
      console.error(`❌ 写入 openclaw.json 失败:`, err.message);
      this.switchLog.error('配置写入失败', err.message);
    }
  }

  _clearLarkSessions() {
    try {
      const result = SessionLockManager.cleanupPluginSessions({
        agentId: 'main',
        removeIndex: true,
        force: false,
        lockStaleMs: 120000
      });

      if (result.deletedSessions > 0 || result.removedLocks > 0) {
        console.log(`🗑️ 已清理 ${result.deletedSessions} 个插件 session，新消息将使用新模型`);
        this.switchLog.info('Session 清理', `删除 ${result.deletedSessions} 个插件会话，下次消息使用新模型`);
      }
      if (result.skippedLocked > 0) {
        this.switchLog.warn('Session 清理', `跳过 ${result.skippedLocked} 个活跃锁会话`);
      }
    } catch (err) {
      console.error(`⚠️ 清理插件 session 失败:`, err.message);
      this.switchLog.warn('Session 清理失败', err.message);
    }
  }

  // ==================== 模型元数据补全 ====================

  /**
   * 已知模型元数据表 — 补全 /models API 未返回的 contextWindow、maxTokens、reasoning、params
   * OpenAI/Anthropic/DeepSeek 的 /models 接口只返回 id，缺少这些关键字段
   */
  static get KNOWN_MODELS() {
    return {
      // GPT-5 / Codex（用户当前主用）
      'gpt-5.3-codex':       { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5.3-codex-spark': { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5.2-codex':       { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5.1-codex-max':   { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5.1-codex-mini':  { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5.1-codex':       { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5-codex-mini':    { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5-codex':         { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5.2':             { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5.1':             { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'gpt-5':               { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      // Claude 4 系列
      'claude-opus-4-6':           { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'claude-sonnet-4-6':         { contextWindow: 200000, maxTokens: 32000, reasoning: true },
      'claude-haiku-4-5-20251001': { contextWindow: 200000, maxTokens: 8192, reasoning: false },
      // Gemini 3 / 2.5 系列
      'gemini':                  { contextWindow: 1000000, maxTokens: 65536, reasoning: true },
      'gemini-3.1-pro-preview':  { contextWindow: 1000000, maxTokens: 65536, reasoning: true },
      'gemini-3-pro-preview':    { contextWindow: 1000000, maxTokens: 65536, reasoning: true },
      'gemini-3-flash-preview':  { contextWindow: 1000000, maxTokens: 65536, reasoning: false },
      'gemini-2.5-pro':          { contextWindow: 1000000, maxTokens: 65536, reasoning: true },
      'gemini-2.5-flash':        { contextWindow: 1000000, maxTokens: 65536, reasoning: false },
      'gemini-2.5-flash-lite':   { contextWindow: 1000000, maxTokens: 65536, reasoning: false },
      // DeepSeek
      'deepseek-chat':     { contextWindow: 64000, maxTokens: 8192, reasoning: false },
      'deepseek-reasoner': { contextWindow: 64000, maxTokens: 8192, reasoning: true },
    };
  }

  _enrichModelMeta(model) {
    // 如果 API 已经返回了丰富数据（OpenRouter / Gemini），直接用
    if (model.contextWindow && model.maxTokens) return model;

    // 用 id 的最后一段匹配（兼容 openrouter 的 "openai/o3-mini" 格式）
    const shortId = model.id.includes('/') ? model.id.split('/').pop() : model.id;
    const known = ModelSwitcher.KNOWN_MODELS[shortId] || ModelSwitcher.KNOWN_MODELS[model.id];

    if (known) {
      if (!model.contextWindow) model.contextWindow = known.contextWindow;
      if (!model.maxTokens) model.maxTokens = known.maxTokens;
      if (model.reasoning === undefined) model.reasoning = known.reasoning;
      if (!model.params && known.params) model.params = known.params;
    }

    return model;
  }

  // ==================== 名称/颜色/图标 ====================

  _getShortName(modelId, modelName) {
    if (modelName && modelName !== modelId) {
      if (modelName.length <= 15) return modelName;
    }
    
    const map = {
      'claude-opus-4-6': 'Opus 4.6',
      'claude-sonnet-4-6': 'Sonnet 4.6',
      'claude-haiku-4-5': 'Haiku 4.5',
      'gpt-5.3-codex': 'GPT-5.3 Codex',
      'gpt-5.3-codex-spark': 'GPT-5.3 Spark',
      'gpt-5.2-codex': 'GPT-5.2 Codex',
      'gpt-5.1-codex-max': 'GPT-5.1 Max',
      'gpt-5.1-codex-mini': 'GPT-5.1 Mini',
      'gpt-5.1-codex': 'GPT-5.1 Codex',
      'gpt-5-codex-mini': 'GPT-5 Mini',
      'gpt-5-codex': 'GPT-5 Codex',
      'gpt-5.2': 'GPT-5.2',
      'gpt-5.1': 'GPT-5.1',
      'gpt-5': 'GPT-5',
      'gemini': 'Gemini',
      'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
      'gemini-3-pro-preview': 'Gemini 3 Pro',
      'gemini-3-flash-preview': 'Gemini 3 Flash',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'gemini-2.5-flash': 'Gemini 2.5 Flash',
      'gemini-2.5-flash-lite': 'Gemini 2.5 Lite',
      'deepseek-chat': 'DeepSeek V3',
      'deepseek-reasoner': 'DeepSeek R1',
      'qwen-max': 'Qwen Max',
      'qwen-turbo': 'Qwen Turbo',
    };
    
    if (map[modelId]) return map[modelId];
    for (const [key, val] of Object.entries(map)) {
      if (modelId.includes(key)) return val;
    }
    
    let short = modelId.replace(/-\d{8}$/, '');
    const parts = short.split('-');
    return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }

  _getModelColor(modelId) {
    const id = modelId.toLowerCase();
    if (id.includes('opus')) return '#E8A838';
    if (id.includes('sonnet')) return '#7C6BF0';
    if (id.includes('haiku')) return '#4ECDC4';
    if (id.includes('codex')) return '#19C37D';
    if (id.includes('gpt-5')) return '#10A37F';
    if (id.includes('o3') || id.includes('o4')) return '#FF6B9D';
    if (id.includes('gpt-4o-mini')) return '#74AA9C';
    if (id.includes('gpt')) return '#10A37F';
    if (id.includes('gemini')) return '#4285F4';
    if (id.includes('deepseek')) return '#4D6BFE';
    if (id.includes('qwen')) return '#6236FF';
    if (id.includes('llama')) return '#0467DF';
    if (id.includes('kimi') || id.includes('k2')) return '#000000';
    if (id.includes('glm')) return '#4361EE';
    if (id.includes('minimax')) return '#FF4040';
    return '#FF6B6B';
  }

  _getModelIcon(modelId) {
    const id = modelId.toLowerCase();
    if (id.includes('opus')) return 'OP';
    if (id.includes('sonnet')) return 'SN';
    if (id.includes('haiku')) return 'HK';
    if (id.includes('codex-max')) return '5M';
    if (id.includes('codex-mini')) return '5m';
    if (id.includes('codex')) return '5C';
    if (id.includes('gpt-5.3')) return '53';
    if (id.includes('gpt-5.1')) return '51';
    if (id.includes('gpt-5')) return 'G5';
    if (id.includes('o3')) return 'o3';
    if (id.includes('o4')) return 'o4';
    if (id.includes('gpt-4o-mini')) return '4m';
    if (id.includes('gpt-4o')) return '4o';
    if (id.includes('gpt-4')) return 'G4';
    if (id.includes('gemini') && id.includes('pro')) return 'GP';
    if (id.includes('gemini') && id.includes('flash')) return 'GF';
    if (id.includes('gemini')) return 'GM';
    if (id.includes('deepseek') && id.includes('reason')) return 'R1';
    if (id.includes('deepseek')) return 'DS';
    if (id.includes('qwen')) return 'QW';
    if (id.includes('llama')) return 'LL';
    if (id.includes('kimi') || id.includes('k2')) return 'K2';
    if (id.includes('glm')) return 'GL';
    if (id.includes('minimax')) return 'MM';
    return modelId.substring(0, 2).toUpperCase();
  }

  // ==================== 工具方法 ====================

  onChange(callback) {
    this.listeners.push(callback);
    return () => { this.listeners = this.listeners.filter(cb => cb !== callback); };
  }

  _notifyListeners() {
    for (const cb of this.listeners) {
      try { cb(this.currentModel, this.currentIndex, this.models); } catch (err) {
        console.error('ModelSwitcher listener error:', err);
      }
    }
  }

  reload() {
    this._loadConfig();
    this._notifyListeners();
  }

  getTrayMenuItems() {
    const groups = {};
    for (const model of this.models) {
      if (!groups[model.provider]) groups[model.provider] = [];
      groups[model.provider].push(model);
    }

    const items = [];
    for (const [provider, models] of Object.entries(groups)) {
      const providerModels = models.map(model => {
        const isCurrent = this.currentModel?.id === model.id;
        return {
          label: `${isCurrent ? '✓ ' : ''}${model.icon} ${model.shortName}`,
          type: 'radio',
          checked: isCurrent,
          click: () => this.switchTo(model.id)
        };
      });
      
      items.push({
        label: `${provider} (${models.length})`,
        submenu: providerModels
      });
    }
    return items;
    return items;
  }

  getStatusText() {
    if (!this.currentModel) return 'No Model';
    return `${this.currentModel.icon} ${this.currentModel.shortName}`;
  }

  // ==================== 智能套餐识别 ====================

  async detectAvailableModels(providerName) {
    const provider = this.providers[providerName];
    if (!provider) throw new Error(`Provider "${providerName}" not found`);

    const testModels = [
      { id: 'claude-opus-4-6', api: 'anthropic-messages', family: 'claude' },
      { id: 'gemini-2.5-pro', api: 'openai-completions', family: 'gemini' },
      { id: 'gpt-5.2-codex', api: 'openai-responses', family: 'codex' }
    ];

    const results = { claude: false, gemini: false, codex: false };

    for (const model of testModels) {
      try {
        // 根据 pathMapping 构建正确的 baseURL
        let testBaseUrl = provider.baseUrl;
        if (provider.pathMapping) {
          const pathSuffix = provider.pathMapping[model.family] || provider.pathMapping.openai;
          if (pathSuffix) {
            testBaseUrl = this._joinBaseWithSuffix(provider.baseUrl, pathSuffix);
          }
        }

        console.log(`  测试 ${model.family}: ${testBaseUrl}`);
        const result = await this._probeOneApi(
          { ...provider, baseUrl: testBaseUrl, models: [model] },
          model.api,
          5000
        );
        console.log(`  结果: connectable=${result.connectable}, routeFound=${result.routeFound}, verdict=${result.verdict}`);
        if (result.connectable && result.routeFound) {
          results[model.family] = true;
        }
      } catch (e) {
        console.log(`  错误: ${e.message}`);
      }
    }

    return results;
  }

  guessPackage(availableModels) {
    const { claude, gemini, codex } = availableModels;
    const available = [];

    if (claude) available.push('Claude');
    if (gemini) available.push('Gemini');
    if (codex) available.push('Codex');

    if (available.length === 0) {
      return { series: '无可用模型', confidence: 'low', models: [] };
    }

    if (available.length === 3) {
      return { series: '全模型系列', confidence: 'high', models: available };
    }

    const seriesName = available.join(' + ') + ' 系列';
    return { series: seriesName, confidence: 'high', models: available };
  }

  async queryQuota(providerName, useCache = true) {
    const provider = this.providers[providerName];
    if (!provider) throw new Error(`Provider "${providerName}" not found`);
    if (!provider.apiKey) throw new Error('API Key not configured');

    if (useCache) {
      const cached = this.quotaCache.get(providerName);
      if (cached && Date.now() - cached.timestamp < 300000) {
        return cached.data;
      }
    }

    const quotaQuery = new QuotaQuery();
    const quota = await quotaQuery.queryQuota(provider.apiKey);
    this.quotaCache.set(providerName, { data: quota, timestamp: Date.now() });
    return quota;
  }

  checkQuotaWarning(quota) {
    const warnings = [];
    const { percentage, used, limit } = quota.opusWeekly;

    if (percentage >= 95) {
      warnings.push({ level: 'critical', message: `Opus 周限额即将用完 ($${used.toFixed(2)}/$${limit})` });
    } else if (percentage >= 80) {
      warnings.push({ level: 'warning', message: `Opus 周限额已用 ${percentage}%` });
    }

    return warnings;
  }

  async analyzeKKCLAW(providerName) {
    const provider = this.providers[providerName];
    if (!provider) throw new Error(`Provider "${providerName}" not found`);

    const [available, quota] = await Promise.all([
      this.detectAvailableModels(providerName).catch(() => null),
      this.queryQuota(providerName, true).catch(() => null)
    ]);

    const result = {
      provider: providerName,
      series: available ? this.guessPackage(available) : null,
      quota: quota,
      warnings: quota ? this.checkQuotaWarning(quota) : []
    };

    return result;
  }

  async syncProviderModels(providerName) {
    const provider = this.providers[providerName];
    if (!provider) throw new Error(`Provider "${providerName}" not found`);

    const preset = this._matchPreset(providerName, provider.baseUrl);
    if (!preset?.models) throw new Error('No preset models found');

    await this.configWriter.writeImmediately({
      [`models.providers.${providerName}.models`]: preset.models
    });
    this._loadConfig();

    return { success: true, count: preset.models.length };
  }

  getFullStatus() {
    return {
      providers: this.getProviders(),
      models: this.models,
      current: this.currentModel,
      currentIndex: this.currentIndex,
      presets: this.getPresets(),
      apiTypes: Object.entries(API_TYPES).map(([key, val]) => ({ key, ...val })),
      speedTestResults: this.speedTestResults,
    };
  }
}

module.exports = ModelSwitcher;
