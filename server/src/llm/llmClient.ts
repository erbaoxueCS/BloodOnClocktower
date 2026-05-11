// ============================================================
// LLM 客户端：封装 API 调用、重试、限流、超时
// ============================================================

let API_KEY = '';
let BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode';
let MODEL = 'qwen-plus';
let ENABLED = true;

// 配置 fetch 代理（Node.js 原生 fetch 需要显式设置）
let _undiciFetch: any = undefined;
let _dispatcher: any = undefined;

function getProxyUrl(): string | undefined {
  return process.env.https_proxy || process.env.HTTPS_PROXY
    || process.env.http_proxy || process.env.HTTP_PROXY
    || undefined;
}

async function setupUndiciFetch(): Promise<any | null> {
  if (_undiciFetch !== undefined) return _undiciFetch;
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) {
    _undiciFetch = null;
    console.log('[LLM] no proxy configured, using global fetch');
    return null;
  }
  try {
    const undici = await import('undici');
    _dispatcher = new undici.ProxyAgent({ uri: proxyUrl });
    _undiciFetch = undici.fetch;
    console.log(`[LLM] undici ProxyAgent + fetch loaded for ${proxyUrl}`);
    return _undiciFetch;
  } catch {
    console.log('[LLM] undici not available, using global fetch');
    _undiciFetch = null;
    _dispatcher = null;
    return null;
  }
}

async function fetchWithProxy(url: string, init: RequestInit): Promise<Response> {
  const f = await setupUndiciFetch();
  if (f && _dispatcher) {
    return f(url, { ...init, dispatcher: _dispatcher });
  }
  return fetch(url, init);
}

export function configureLlm(options: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled?: boolean;
}): void {
  if (options.apiKey !== undefined) API_KEY = options.apiKey;
  if (options.baseUrl !== undefined) BASE_URL = options.baseUrl.replace(/\/+$/, '');
  if (options.model !== undefined) MODEL = options.model;
  if (options.enabled !== undefined) ENABLED = options.enabled;
  const proxy = getProxyUrl();
  console.log(`[LLM] configured: enabled=${ENABLED}, model=${MODEL}, baseUrl=${BASE_URL}, proxy=${proxy ?? '(none)'}`);
}

export function getLlmConfig() {
  return { apiKey: API_KEY ? `***${API_KEY.slice(-4)}` : '(empty)', baseUrl: BASE_URL, model: MODEL, enabled: ENABLED };
}

// 消息格式
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  raw: string;
  json: Record<string, unknown> | null;
  usage?: { promptTokens: number; completionTokens: number };
  elapsedMs: number;
}

let activeRequests = 0;
const MAX_CONCURRENT = 3;
const queue: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeRequests < MAX_CONCURRENT) {
      activeRequests++;
      resolve();
    } else {
      queue.push(() => {
        activeRequests++;
        resolve();
      });
    }
  });
}

function releaseSlot(): void {
  activeRequests--;
  const next = queue.shift();
  if (next) next();
}

function computeBackoffMs(attempt: number): number {
  const base = 400;
  const cap = 6000;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return exp + Math.floor(Math.random() * 200);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status === 425 || (status >= 500 && status <= 599);
}

export async function callLlm(
  messages: LlmMessage[],
  options?: {
    temperature?: number;
    jsonMode?: boolean;
    timeoutMs?: number;
    maxAttempts?: number;
  },
): Promise<LlmResponse> {
  if (!ENABLED) {
    throw new Error('LLM disabled');
  }

  const startedAt = Date.now();
  const maxAttempts = options?.maxAttempts ?? 4;
  const timeoutMs = options?.timeoutMs ?? 30000;
  const jsonMode = options?.jsonMode ?? true;

  console.log(`[LLM] request starting (jsonMode=${jsonMode}, timeout=${timeoutMs}ms, attempts=${maxAttempts})`);

  await acquireSlot();

  let lastError: string = '';

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);

        const body: Record<string, unknown> = {
          model: MODEL,
          messages,
          temperature: options?.temperature ?? (jsonMode ? 0.3 : 0.8),
          stream: false,
        };

        if (jsonMode) {
          body.response_format = { type: 'json_object' };
        }

        const res = await fetchWithProxy(`${BASE_URL}/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${API_KEY}`,
          },
          body: JSON.stringify(body),
          signal: ac.signal,
        });

        clearTimeout(t);

        if (!res.ok) {
          const errBody = await res.text().catch(() => '');
          if (isRetryable(res.status) && attempt < maxAttempts - 1) {
            await sleep(computeBackoffMs(attempt));
            continue;
          }
          throw new Error(`LLM HTTP ${res.status}: ${errBody.slice(0, 300)}`);
        }

        const data = await res.json() as {
          choices?: Array<{ message?: { content?: string } }>;
          usage?: { prompt_tokens: number; completion_tokens: number };
        };

        const rawContent = data.choices?.[0]?.message?.content ?? '';
        let json: Record<string, unknown> | null = null;

        console.log(`[LLM] success: ${rawContent.slice(0, 80)}... (${Date.now() - startedAt}ms)`);

        if (jsonMode) {
          try {
            json = JSON.parse(rawContent.trim());
          } catch {
            // 尝试从 markdown code block 中提取
            const m = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (m) {
              try {
                json = JSON.parse(m[1].trim());
              } catch { /* ignore */ }
            }
            if (!json) {
              // 尝试找到第一个 { } 或 [ ] 块
              const jsonMatch = rawContent.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
              if (jsonMatch) {
                try {
                  json = JSON.parse(jsonMatch[0]);
                } catch { /* ignore */ }
              }
            }
          }
        }

        return {
          raw: rawContent,
          json,
          usage: data.usage ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
          } : undefined,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        const isTimeout = lastError.includes('aborted') || lastError.includes('timeout');
        console.error(`[LLM] attempt ${attempt + 1}/${maxAttempts} failed${isTimeout ? ' (timeout)' : ''}: ${lastError.slice(0, 200)}`);
        if (attempt < maxAttempts - 1) {
          await sleep(computeBackoffMs(attempt));
        }
      }
    }

    console.error(`[LLM] ALL ${maxAttempts} attempts failed. Last error: ${lastError}`);
    throw new Error(`LLM call failed after ${maxAttempts} attempts: ${lastError}`);
  } finally {
    releaseSlot();
  }
}
