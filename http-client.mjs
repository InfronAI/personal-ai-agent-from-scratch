import { AppError } from "./errors.mjs";

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryDelay(response, attempt) {
  const retryAfter = Number(response?.headers?.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(5000, retryAfter * 1000);
  return Math.min(2500, (200 * (2 ** attempt)) + Math.floor(Math.random() * 150));
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function fetchWithRetry(url, options, { timeoutMs, retries, signal, service }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    try {
      const response = await fetch(url, { ...options, signal: combinedSignal });
      if (!RETRYABLE_STATUS.has(response.status) || attempt === retries) return response;
      await response.body?.cancel();
      await wait(retryDelay(response, attempt), signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      lastError = error;
      if (attempt === retries) break;
      await wait(retryDelay(null, attempt), signal);
    }
  }
  throw new AppError(`${service} is temporarily unavailable`, {
    code: "upstream_unavailable", status: 503, retryable: true, expose: true, cause: lastError
  });
}
