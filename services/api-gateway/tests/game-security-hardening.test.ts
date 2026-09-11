import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AppError } from '../src/lib/errors.js';
import {
  assertExpectedPrice,
  checkedItemValue,
  POSTGRES_BIGINT_MAX,
} from '../src/routes/upgrades.js';

void describe('gameplay security hardening', () => {
  void it('accepts the PostgreSQL bigint boundary and rejects aggregate overflow', () => {
    assert.equal(checkedItemValue(0n, POSTGRES_BIGINT_MAX, 1), POSTGRES_BIGINT_MAX);
    assert.equal(checkedItemValue(10n, 5n, 3), 25n);

    assert.throws(
      () => checkedItemValue(POSTGRES_BIGINT_MAX - 1n, 1n, 2),
      (error: unknown) => error instanceof AppError && error.code === 'VALUE_OUT_OF_RANGE',
    );
    assert.throws(
      () => checkedItemValue(0n, 1n, Number.MAX_SAFE_INTEGER + 1),
      (error: unknown) => error instanceof AppError && error.code === 'VALUE_OUT_OF_RANGE',
    );
  });

  void it('fails closed when a fixed item price no longer matches the request quote', () => {
    assert.doesNotThrow(() => assertExpectedPrice('12500', '12500', 'target'));
    assert.throws(
      () => assertExpectedPrice('12501', '12500', 'target'),
      (error: unknown) =>
        error instanceof AppError && error.statusCode === 409 && error.code === 'PRICE_CHANGED',
    );
  });

  void it('migrates request binding, replay metadata, runtime grants, and lookup indexes', async () => {
    const sql = await readFile(
      path.resolve(
        import.meta.dirname,
        '../../../packages/db/migrations/002_security_hardening.sql',
      ),
      'utf8',
    );
    assert.match(sql, /ALTER TABLE upgrader_rounds[\s\S]*ADD COLUMN request_hash char\(64\)/);
    assert.match(sql, /ALTER TABLE withdrawals[\s\S]*ADD COLUMN request_hash char\(64\)/);
    assert.match(sql, /ALTER TABLE admin_commands[\s\S]*ADD COLUMN request_hash char\(64\)/);
    assert.match(sql, /ADD COLUMN bot_id uuid REFERENCES bot_accounts\(id\)/);
    assert.match(sql, /ALTER TABLE bot_accounts ADD COLUMN transfer_capable boolean NOT NULL/);
    assert.match(sql, /ALTER TABLE inbound_bot_events ADD COLUMN response_body jsonb/);
    assert.match(sql, /ALTER TABLE audit_log ADD COLUMN sequence_no bigint/);
    assert.match(sql, /CREATE UNIQUE INDEX audit_log_one_successor_idx/);
    assert.match(sql, /FOREIGN KEY \(previous_hash\) REFERENCES audit_log\(entry_hash\)/);
    assert.match(sql, /CREATE TRIGGER audit_log_chain_insert/);
    assert.match(sql, /CREATE INDEX custody_movements_from_user_idx/);
    assert.match(sql, /CREATE ROLE donut_api_runtime NOLOGIN/);
    assert.match(sql, /GRANT SELECT ON audit_log TO donut_audit_reader/);

    const updateGrant = /GRANT UPDATE ON([\s\S]*?)TO donut_api_runtime;/m.exec(sql)?.[1] ?? '';
    for (const appendOnlyTable of [
      'audit_log',
      'custody_movements',
      'upgrader_rounds',
      'upgrader_stakes',
      'upgrader_awards',
      'catalog_price_history',
      'admin_commands',
      'inbound_bot_events',
    ]) {
      assert.doesNotMatch(updateGrant, new RegExp(`\\b${appendOnlyTable}\\b`));
    }
  });
});
