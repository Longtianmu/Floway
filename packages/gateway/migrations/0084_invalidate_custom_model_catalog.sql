-- Custom model endpoint inference now recognizes OpenAI moderation model
-- families. The catalog is derived from the upstream model list, so an older
-- cached projection may still advertise those models as the configured
-- fallback kind. Drop only Custom's derived cache and leave the operator's
-- authoritative config_json (including every manual model) untouched.
UPDATE upstreams
SET models_cache_json = NULL
WHERE provider = 'custom'
  AND models_cache_json IS NOT NULL;
