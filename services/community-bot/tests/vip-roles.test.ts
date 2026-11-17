import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { VIP_ROLE_IDS, vipRoleChanges } from '../src/features/vip-roles.js';

/* The owner, 2026-11-17: "sync users vip levels with their roles on the site ... users that didnt link
 * keep the member role the autorole gives them". */

const MEMBER = '1500000000000000001'; // the autorole's member role: never touched
const { bronze, silver, gold, high_roller: highRoller } = VIP_ROLE_IDS;

describe('VIP roles in Discord', () => {
  it('uses the six role ids the owner gave', () => {
    assert.deepEqual(VIP_ROLE_IDS, {
      bronze: '1572199044506325042',
      silver: '1572224218421010514',
      gold: '1572224297265791029',
      platinum: '1572224380287852654',
      diamond: '1572224427297349694',
      high_roller: '1572224532268327034',
    });
  });

  it('gives a newly linked member their tier, and nothing else changes', () => {
    assert.deepEqual(vipRoleChanges([MEMBER], 'gold'), { add: [gold], remove: [] });
  });

  it('moves a member to their new tier', () => {
    assert.deepEqual(vipRoleChanges([MEMBER, silver], 'gold'), { add: [gold], remove: [silver] });
    // Two VIP roles at once (somebody added one by hand): the wrong one goes.
    assert.deepEqual(vipRoleChanges([bronze, gold], 'gold'), { add: [], remove: [bronze] });
  });

  it('leaves a member already on the right tier alone', () => {
    assert.deepEqual(vipRoleChanges([MEMBER, highRoller], 'high_roller'), { add: [], remove: [] });
  });

  it('takes every VIP role off a member who is not linked, and keeps their member role', () => {
    const change = vipRoleChanges([MEMBER, silver], undefined);
    assert.deepEqual(change, { add: [], remove: [silver] });
    assert.ok(!change.remove.includes(MEMBER));
    assert.deepEqual(vipRoleChanges([MEMBER], undefined), { add: [], remove: [] });
  });

  it('runs every ten minutes from the bot’s start, and stops with it', async () => {
    const server = await readFile(path.join(import.meta.dirname, '../src/server.ts'), 'utf8');
    assert.match(server, /stopVipRoles = startVipRoleSync\(ready, api, config\.guildId, \{/);
    assert.match(server, /stopTagWatch\(\);\n\s+stopVipRoles\(\);/);
    const feature = await readFile(path.join(import.meta.dirname, '../src/features/vip-roles.ts'), 'utf8');
    assert.match(feature, /const SWEEP_MS = 10 \* 60_000;/);
    // Roles are added and removed one by one, never replaced wholesale (which could drop others).
    assert.doesNotMatch(feature, /roles\.set\(/);
  });
});
