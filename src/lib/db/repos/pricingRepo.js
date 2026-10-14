import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { makeKv } from "../helpers/kvStore.js";

const pricingKv = makeKv("pricing");
const CACHE_TTL_MS = 5000;

let cache = { value: null, expiresAt: 0 };

function invalidate() {
  cache = { value: null, expiresAt: 0 };
}

async function getUserPricing() {
  return await pricingKv.getAll();
}

export async function getPricing() {
  const now = Date.now();
  if (cache.value && cache.expiresAt > now) return cache.value;

  const userPricing = await getUserPricing();
  const { PROVIDER_PRICING } = await import("open-sse/providers/pricing.js");
  const merged = {};

  for (const [provider, models] of Object.entries(PROVIDER_PRICING)) {
    merged[provider] = { ...models };
    if (userPricing[provider]) {
      for (const [model, pricing] of Object.entries(userPricing[provider])) {
        merged[provider][model] = merged[provider][model]
          ? { ...merged[provider][model], ...pricing }
          : pricing;
      }
    }
  }

  for (const [provider, models] of Object.entries(userPricing)) {
    if (!merged[provider]) {
      merged[provider] = { ...models };
    } else {
      for (const [model, pricing] of Object.entries(models)) {
        if (!merged[provider][model]) merged[provider][model] = pricing;
      }
    }
  }

  cache = { value: merged, expiresAt: now + CACHE_TTL_MS };
  return merged;
}

export async function getPricingForModel(provider, model) {
  if (!model) return null;
  const userPricing = await getUserPricing();
  if (provider && userPricing[provider]?.[model]) return userPricing[provider][model];
  const { getPricingForModel: resolveConst } = await import("open-sse/providers/pricing.js");
  return resolveConst(provider, model);
}

// Atomic merge inside transaction (per-provider read-modify-write)
export async function updatePricing(pricingData) {
  const db = await getAdapter();
  db.transaction(() => {
    for (const [provider, models] of Object.entries(pricingData)) {
      const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      const current = row ? (parseJson(row.value, {}) || {}) : {};
      const merged = { ...current };
      for (const [model, pricing] of Object.entries(models)) {
        merged[model] = pricing;
      }
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(merged)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetPricing(provider, model) {
  if (!provider) return await getUserPricing();
  const db = await getAdapter();
  db.transaction(() => {
    if (!model) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
      return;
    }
    const row = db.get(`SELECT value FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    const current = row ? (parseJson(row.value, {}) || {}) : {};
    delete current[model];
    if (Object.keys(current).length === 0) {
      db.run(`DELETE FROM kv WHERE scope = 'pricing' AND key = ?`, [provider]);
    } else {
      db.run(
        `INSERT INTO kv(scope, key, value) VALUES('pricing', ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
        [provider, stringifyJson(current)]
      );
    }
  });
  invalidate();
  return await getUserPricing();
}

export async function resetAllPricing() {
  await pricingKv.clear();
  invalidate();
  return {};
}

/**
 * Calculate cost from canonical tokens (prompt_tokens, completion_tokens, cached_tokens, reasoning_tokens, cache_creation_input_tokens)
 * Returns cost in USD. Uses pricing from open-sse/providers/pricing.js which expects cache-inclusive prompt_tokens.
 * Returns null when pricing is unknown (no rate) so callers can distinguish "unknown" from "free".
 * @param {object} tokens - canonical token object
 * @param {object} pricing - pricing object with input, output, cached, reasoning, cache_creation rates per 1M
 * @returns {number|null}
 */
export function calculateCost(tokens, pricing) {
  if (!tokens || !pricing) return null;

  const inputRate = pricing.input == null ? NaN : Number(pricing.input);
  const outputRate = pricing.output == null ? NaN : Number(pricing.output);
  const cachedRate = pricing.cached == null ? NaN : Number(pricing.cached);
  const reasoningRate = pricing.reasoning == null ? NaN : Number(pricing.reasoning);
  const cacheCreationRate = pricing.cache_creation == null ? NaN : Number(pricing.cache_creation);

  // Missing or negative rates are not free; explicit zero rates are.
  if (!Number.isFinite(inputRate) || inputRate < 0 || !Number.isFinite(outputRate) || outputRate < 0) return null;

  const promptTokens = Number(tokens.prompt_tokens) || 0;
  const completionTokens = Number(tokens.completion_tokens) || 0;
  const cachedTokens = Number(tokens.cached_tokens) || 0;
  const reasoningTokens = Number(tokens.reasoning_tokens) || 0;
  const cacheCreationTokens = Number(tokens.cache_creation_input_tokens) || 0;

  // prompt_tokens is cache-inclusive. Subtract cached and cache_creation to get non-cached portion
  const nonCachedInput = Math.max(0, promptTokens - cachedTokens - cacheCreationTokens);

  let cost = 0;
  cost += nonCachedInput * (inputRate / 1000000);
  cost += cachedTokens * ((Number.isFinite(cachedRate) && cachedRate >= 0 ? cachedRate : inputRate) / 1000000);
  cost += completionTokens * (outputRate / 1000000);
  // reasoning_tokens are a SUBSET of completion_tokens (already included in completion_tokens).
  // Do NOT add reasoning on top of completion - that double-counts.
  // If pricing.reasoning is explicitly set, use it ONLY for the reasoning subset portion.
  if (reasoningTokens > 0 && Number.isFinite(reasoningRate) && reasoningRate >= 0) {
    cost += reasoningTokens * ((reasoningRate - outputRate) / 1000000);
  }
  if (cacheCreationTokens > 0) {
    cost += cacheCreationTokens * ((Number.isFinite(cacheCreationRate) && cacheCreationRate >= 0 ? cacheCreationRate : inputRate) / 1000000);
  }

  return cost;
}
