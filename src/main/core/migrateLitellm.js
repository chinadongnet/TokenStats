import { LITELLM_CONFIG, LITELLM_DEFAULT_COLOR } from './paths.js'
import { DEFAULT_SYNC_MINUTES } from './parsers/litellm.js'

// One-time import of the old single-provider `litellm: {baseUrl, apiKey}`
// config.json block into the DB-backed multi-provider Settings system. Runs
// once on the first startup after upgrading; a no-op on every startup after
// that (or if the user never had a legacy config, or already has providers).
// The old config.json block is left in place untouched — harmless dead config,
// kept only so this migration stays possible if the DB is ever wiped.
export function migrateLegacyLitellmConfig(db) {
  try {
    if (!LITELLM_CONFIG) return
    if (db.listLitellmProviders().length > 0) return
    db.upsertLitellmProvider({
      name: 'LiteLLM',
      baseUrl: LITELLM_CONFIG.baseUrl,
      apiKey: LITELLM_CONFIG.apiKey,
      color: LITELLM_DEFAULT_COLOR,
      syncMinutes: DEFAULT_SYNC_MINUTES,
      enabled: true,
    })
  } catch {
    // best-effort; never block startup over a migration failure
  }
}
