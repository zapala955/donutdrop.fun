import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

const repo = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFile(path.join(repo, relative), 'utf8');

describe('global chat clear', () => {
  it('stores an append-only reset boundary and pins readiness to it', async () => {
    const [migration, health] = await Promise.all([
      read('packages/db/migrations/040_chat_clear_events.sql'),
      read('services/api-gateway/src/routes/health.ts'),
    ]);
    assert.match(migration, /CREATE TABLE chat_clear_events/);
    assert.match(migration, /GRANT SELECT, INSERT ON TABLE chat_clear_events/);
    assert.doesNotMatch(migration, /GRANT (?:UPDATE|DELETE|TRUNCATE).*chat_clear_events/);
    assert.match(migration, /CREATE FUNCTION donut_schema_ready_v40\(\)/);
    assert.match(health, /donut_schema_ready_v41\(\)/);
  });

  it('soft-deletes visible messages behind the admin guard and audits the clear', async () => {
    const route = await read('services/api-gateway/src/routes/chat.ts');
    const start = route.indexOf("'/v1/admin/chat/clear'");
    const end = route.indexOf("'/v1/chat/:id'", start);
    const endpoint = route.slice(start, end);
    assert.ok(start >= 0 && end > start, 'chat clear endpoint must exist before single deletion');
    assert.match(endpoint, /guards\.requireAdmin/);
    assert.match(endpoint, /UPDATE chat_messages/);
    assert.match(endpoint, /SET deleted_at = now\(\), deleted_by = \$1/);
    assert.doesNotMatch(endpoint, /DELETE FROM chat_messages/);
    assert.match(endpoint, /INSERT INTO chat_clear_events/);
    assert.match(endpoint, /action: 'chat\.clear'/);
    assert.match(endpoint, /messagesCleared/);
  });

  it('publishes the reset and makes every open client discard the old timeline', async () => {
    const [route, store, chat, markup, admin] = await Promise.all([
      read('services/api-gateway/src/routes/chat.ts'),
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/store.js'),
      read('DONUTDROP FRONTEND/Donut Drop/assets/js/chat.js'),
      read('DONUTDROP FRONTEND/Donut Drop/admin/index.html'),
      read('DONUTDROP FRONTEND/Donut Drop/admin/admin.js'),
    ]);
    assert.match(route, /m\.created_at > \$2/);
    assert.match(route, /reset: reset \? \{ id: reset\.id, clearedAt: reset\.cleared_at \}/);
    assert.match(store, /resetId: result\.reset\?\.id/);
    assert.match(chat, /function applyChatReset\(\)/);
    assert.match(chat, /seenMessages\.clear\(\)/);
    assert.match(chat, /seenHits\.clear\(\)/);
    assert.match(chat, /log\.replaceChildren\(\)/);
    assert.match(chat, /activity\.createdAt.*<= clearedAt/);
    assert.match(markup, /id="clearChat"/);
    assert.match(admin, /api\.post\('\/v1\/admin\/chat\/clear', \{ reason \}\)/);
    assert.match(admin, /confirmAction\(/);
  });
});
