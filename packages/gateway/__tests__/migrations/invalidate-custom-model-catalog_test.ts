import { DatabaseSync } from 'node:sqlite';

import { test } from 'vitest';

import { migrationSqlByFilename } from '../repo/test-sqlite.ts';
import { assertEquals } from '@floway-dev/test-utils';

const MIGRATION = '0084_invalidate_custom_model_catalog.sql';

test('the moderation catalog migration invalidates only Custom derived model caches', () => {
  const db = new DatabaseSync(':memory:');
  const insert = () => db.prepare(`INSERT INTO upstreams (
    id, provider, name, created_at, updated_at, config_json, models_cache_json, hue
  ) VALUES (?, ?, 'test', '2026-01-01', '2026-01-01', ?, ?, 210)`);

  for (const [filename, sql] of migrationSqlByFilename) {
    if (filename === MIGRATION) {
      const manualConfig = JSON.stringify({
        endpoints: { openaiChatCompletions: {} },
        models: [{ upstreamModelId: 'manual', kind: 'chat', endpoints: { openaiChatCompletions: {} } }],
      });
      insert().run('custom_cached', 'custom', manualConfig, '{"revision":6,"models":[]}');
      insert().run('custom_uncached', 'custom', '{"models":[]}', null);
      insert().run('azure_cached', 'azure', '{"models":[]}', '{"revision":6,"models":[]}');
    }
    db.exec(sql);
  }

  const rows = db.prepare('SELECT id, config_json, models_cache_json FROM upstreams ORDER BY id').all() as {
    id: string;
    config_json: string;
    models_cache_json: string | null;
  }[];
  db.close();

  assertEquals(rows, [
    { id: 'azure_cached', config_json: '{"models":[]}', models_cache_json: '{"revision":6,"models":[]}' },
    {
      id: 'custom_cached',
      config_json: '{"endpoints":{"openaiChatCompletions":{}},"models":[{"upstreamModelId":"manual","kind":"chat","endpoints":{"openaiChatCompletions":{}}}]}',
      models_cache_json: null,
    },
    { id: 'custom_uncached', config_json: '{"models":[]}', models_cache_json: null },
  ]);
});
