import { config } from "./config.mjs";
import { AppError } from "./errors.mjs";
import { fetchWithRetry } from "./http-client.mjs";

function finiteInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function cleanResult(result) {
  return {
    title: String(result?.title || "Untitled source").slice(0, 300),
    url: String(result?.url || "").slice(0, 2000),
    content: String(result?.content || "").replace(/\s+/g, " ").trim().slice(0, 1200),
    score: Number.isFinite(Number(result?.score)) ? Number(result.score) : null
  };
}

export async function searchWithTavily(query, options = {}) {
  const connection = {
    apiKey: options.connection?.apiKey || process.env.WEB_SEARCH_API_KEY || config.webSearch.apiKey,
    baseUrl: String(options.connection?.baseUrl || process.env.WEB_SEARCH_BASE_URL || config.webSearch.baseUrl).replace(/\/$/u, "")
  };
  if (!connection.apiKey) throw new AppError("Web Search API credential is not configured", { code: "search_not_configured", status: 503, expose: true });

  const maxResults = finiteInteger(options.maxResults, 5, 1, 8);
  try {
    const response = await fetchWithRetry(`${connection.baseUrl}/search`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${connection.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Connection": "close",
        "User-Agent": `Personal-Copilot-Tavily-Search/${config.service.version}`,
        "X-Request-Id": options.requestId || "copilot-untracked"
      },
      body: JSON.stringify({
        query: String(query).slice(0, 2000),
        search_depth: options.searchDepth === "advanced" ? "advanced" : "basic",
        max_results: maxResults,
        include_answer: true,
        include_raw_content: false,
        include_images: false
      })
    }, { timeoutMs: config.webSearch.timeoutMs, retries: config.webSearch.retries, signal: options.signal, service: "Tavily-compatible Search" });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text.slice(0, 500) };
    }
    if (!response.ok) {
      throw new AppError(`Web Search returned ${response.status}: ${payload?.detail || payload?.error || "search failed"}`, {
        code: "search_upstream_error", status: response.status === 429 ? 429 : 502,
        retryable: response.status === 429 || response.status >= 500, expose: true
      });
    }

    return {
      query: String(payload.query || query),
      answer: String(payload.answer || "").trim().slice(0, 5000),
      results: Array.isArray(payload.results) ? payload.results.slice(0, maxResults).map(cleanResult) : [],
      responseTimeSeconds: Number(payload.response_time || 0) || null,
      requestId: String(payload.request_id || "") || null,
      provider: String(payload.provider || "tavily-compatible")
    };
  } catch (error) {
    if (error.name === "TimeoutError") throw new AppError(`Web Search timed out after ${config.webSearch.timeoutMs} ms`, { code: "search_timeout", status: 504, retryable: true, expose: true });
    throw error;
  }
}
