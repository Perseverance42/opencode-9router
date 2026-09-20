// ── OpenCode V2 adapter ─────────────────────────────────────
// Bridges the shared discovery pipeline onto the OpenCode v2 plugin API
// (default export with `id` + `setup`, provider/model registry transforms).
// The v1 entrypoint stays in plugin.ts; plugin.ts default-exports both from
// one package per the official dual-support pattern (v1 calls `server()`,
// v2 calls `setup()`).

import { Model, Plugin, Provider } from "@opencode/plugin";
import {
  DEFAULT_BASE_URL,
  DISCOVERY_CACHE_TTL,
  DISCOVERY_TIMEOUT,
  PLUGIN_NAME,
  PROVIDER_DISPLAY_NAME,
} from "./constants.js";
import { discoverModels, type DiscoveryLogger } from "./discovery.js";
import { ensureAPIPath, normalizeBaseURL } from "./utils.js";
import type { ModelConfig } from "./types.js";

/** Canonical built-in OpenAI-compatible runtime package in the v2 shape. */
const OPENAI_COMPATIBLE_PACKAGE = "@opencode/ai/providers/openai-compatible";

/**
 * The v2 plugin context exposes no logging API, so log lines go to the
 * process console with a service prefix (best-effort, mirrors v1's
 * best-effort client.app.log behaviour).
 */
function makeLog(): DiscoveryLogger {
  return async (level, message) => {
    const line = `[9router-provider] ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
}

/** Arbitrary keys a user may place next to baseURL/apiKey in provider settings. */
type ProviderSettings = Record<string, unknown>;

type ModelInfoLike = Record<string, unknown> & {
  capabilities: { tools: boolean; input: string[]; output: string[] };
  limit: { context: number; output: number };
};

/**
 * Convert a discovered v1-shape ModelConfig into a v2 Model.Info. Defaults
 * come from Model.Info.default (200K context / 32K output placeholder, empty
 * cost); only fields the discovery pipeline actually resolved are overridden,
 * mirroring the v1 behaviour of emitting optional capability fields.
 */
function toModelInfo(providerID: string, id: string, config: ModelConfig): ModelInfoLike {
  const base = Model.Info.default(providerID as never, id as never) as ModelInfoLike;

  const info: ModelInfoLike = { ...base, name: config.name };

  const input =
    config.modalities?.input ?? (config.attachment ? ["text", "image"] : undefined);
  info.capabilities = {
    tools: config.tool_call ?? true,
    input: input ?? base.capabilities.input,
    output: config.modalities?.output ?? base.capabilities.output,
  };

  // Parity with v1: emit a limit only when the discovery pipeline validated
  // both bounds (image models reporting output: 0 keep the default).
  if (config.limit?.context !== undefined && config.limit?.output !== undefined) {
    info.limit = { context: config.limit.context, output: config.limit.output };
  }

  // v1 variants map keyed by variant id with option records; v2 wants an
  // array of { id, settings } entries.
  if (config.variants) {
    (info as { variants?: unknown }).variants = Object.entries(config.variants).map(
      ([variantID, value]) => ({ id: variantID, settings: value }),
    );
  }

  return info;
}

/**
 * Register (or enrich) every 9router-family provider on the v2 provider
 * registry: discover models per provider, point its runtime package and
 * baseURL at the router API, and publish the discovered model inventory.
 */
export const v2Plugin = Plugin.define({
  id: PLUGIN_NAME,
  async setup(ctx) {
    const log = makeLog();

    // ── Phase 1: ensure a default provider exists when none configured ──
    const initial = await ctx.provider.list();
    if (!initial.data.some((r) => r.id.startsWith("9router"))) {
      await ctx.provider.transform((editor) => {
        if (editor.get(PLUGIN_NAME)) return; // registered by an earlier transform
        editor.add({
          info: {
            ...Provider.Info.empty(PLUGIN_NAME as never),
            name: PROVIDER_DISPLAY_NAME,
            activation: "enabled",
            package: OPENAI_COMPATIBLE_PACKAGE,
            settings: { baseURL: ensureAPIPath(DEFAULT_BASE_URL) },
          } as never,
          models: [],
        });
      });
    }

    // ── Phase 2: discover models for every 9router-family provider ──
    const targets = (await ctx.provider.list()).data.filter((r) =>
      r.id.startsWith("9router"),
    );
    const apiURLs = new Map<string, string>();
    const discovered = new Map<string, Record<string, ModelConfig> | null>();

    const results = await Promise.allSettled(
      targets.map(async (record) => {
        const providerID = record.id;
        const settings = (record.settings ?? {}) as ProviderSettings;
        const baseURL = normalizeBaseURL((settings.baseURL as string) ?? DEFAULT_BASE_URL);
        const apiURL = ensureAPIPath(baseURL);
        apiURLs.set(providerID, apiURL);

        const cacheEnabled = (settings.cache as boolean) ?? true;
        const cacheTTL = (settings.cacheTTL as number) ?? DISCOVERY_CACHE_TTL;
        const discoveryTimeout =
          (settings.discoveryTimeout as number) ?? DISCOVERY_TIMEOUT;

        const models = await discoverModels(
          baseURL,
          settings.apiKey as string | undefined,
          cacheEnabled,
          cacheTTL,
          discoveryTimeout,
          providerID,
          log,
        );
        discovered.set(providerID, models);
        return { providerID, models };
      }),
    );

    // ── Phase 3: publish package/baseURL and the model inventory ──
    await ctx.provider.transform((editor) => {
      for (const [providerID, models] of discovered) {
        const apiURL = apiURLs.get(providerID) ?? DEFAULT_BASE_URL;
        editor.update(providerID as never, (provider) => {
          if (!provider.package) provider.package = OPENAI_COMPATIBLE_PACKAGE;
          provider.settings = { ...provider.settings, baseURL: apiURL };
        });
        // Only publish on success: setting an empty inventory would wipe
        // models the user hand-configured for this provider while the
        // router is unreachable.
        if (!models) continue;
        editor.models.set(
          providerID as never,
          Object.entries(models).map(([modelID, config]) =>
            toModelInfo(providerID, modelID, config),
          ) as never,
        );
      }
    });

    // ── Summary ──
    for (const result of results) {
      if (result.status === "rejected") {
        await log("error", `Provider pipeline error: ${result.reason}`);
        continue;
      }
      const { providerID, models } = result.value;
      const apiURL = apiURLs.get(providerID);
      if (models) {
        await log(
          "info",
          `[${providerID}] Discovered ${Object.keys(models).length} models from ${apiURL}`,
        );
      } else {
        await log(
          "warn",
          `[${providerID}] Failed to discover models from ${apiURL}. Check if the service is running and accessible.`,
        );
      }
    }
  },
});
