import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import type { ChatInputCommandInteraction, ModalSubmitInteraction } from 'discord.js';
import type { PlatformApi } from '../src/api-client.js';
import {
  LINK_CODE_FIELD,
  LINK_MODAL_ID,
  buildLinkModal,
  showLink,
  submitLinkCode,
} from '../src/features/link.js';

/* `/link` used to need `/link code:<code>` typed out, option syntax and all. Now plain `/link`
 * opens a pop-up with one box for the code the site showed. */

function commandInteraction() {
  const calls: { kind: string; payload: unknown }[] = [];
  const interaction = {
    user: { id: '123456789012345678', username: 'member' },
    guildId: '223456789012345678',
    reply: async (payload: unknown) => void calls.push({ kind: 'reply', payload }),
    showModal: async (payload: unknown) => void calls.push({ kind: 'modal', payload }),
  } as unknown as ChatInputCommandInteraction;
  return { interaction, calls };
}

describe('/link', () => {
  it('opens a pop-up asking for the code', () => {
    const modal = buildLinkModal().toJSON();
    assert.equal(modal.custom_id, LINK_MODAL_ID);
    const row = modal.components[0] as unknown as { components: Record<string, unknown>[] };
    const input = row.components[0]!;
    assert.equal(input['custom_id'], LINK_CODE_FIELD);
    assert.equal(input['required'], true);
    assert.equal(input['min_length'], 4);
    assert.equal(input['max_length'], 16);
    assert.match(String(input['placeholder']), /donutwin\.fun\/discord/);
  });

  it('shows the pop-up to somebody who is not linked', async () => {
    const { interaction, calls } = commandInteraction();
    const api = { profile: async () => ({ linked: false }) } as unknown as PlatformApi;
    await showLink(api, interaction);
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['modal'],
    );
  });

  it('says "already linked" instead of asking again', async () => {
    const { interaction, calls } = commandInteraction();
    const api = {
      profile: async () => ({ linked: true, username: 'Steve', linkedAt: null }),
    } as unknown as PlatformApi;
    await showLink(api, interaction);
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['reply'],
    );
    assert.match(JSON.stringify(calls[0]?.payload), /Already linked/);
  });

  it('still opens the pop-up when the site is slow, rather than letting Discord time out', async () => {
    const { interaction, calls } = commandInteraction();
    const api = { profile: () => new Promise(() => undefined) } as unknown as PlatformApi;
    const keepAlive = setInterval(() => undefined, 50);
    try {
      await showLink(api, interaction);
    } finally {
      clearInterval(keepAlive);
    }
    assert.deepEqual(
      calls.map((call) => call.kind),
      ['modal'],
    );
  });

  it('links with the code typed into the pop-up', async () => {
    const linked: unknown[] = [];
    const edits: unknown[] = [];
    const api = {
      link: async (body: unknown) => {
        linked.push(body);
        return { username: 'Steve', rewards: [], joinSkipped: null };
      },
    } as unknown as PlatformApi;
    const interaction = {
      user: { id: '123456789012345678', username: 'member' },
      guildId: '223456789012345678',
      fields: { getTextInputValue: (id: string) => (id === LINK_CODE_FIELD ? ' K7PQ2MXA ' : '') },
      deferReply: async () => undefined,
      editReply: async (payload: unknown) => void edits.push(payload),
    } as unknown as ModalSubmitInteraction;
    await submitLinkCode(api, interaction);
    assert.deepEqual(linked, [
      {
        discordUserId: '123456789012345678',
        discordUsername: 'member',
        guildId: '223456789012345678',
        code: 'K7PQ2MXA',
      },
    ]);
    assert.match(JSON.stringify(edits[0]), /now linked to \*\*Steve\*\*/);
  });

  it('routes the pop-up back to the linking', async () => {
    const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
    assert.match(
      server,
      /if \(prefix === 'link' && action === 'code'\) return submitLinkCode\(api, interaction\);/,
    );
    assert.equal(LINK_MODAL_ID, 'link:code');
  });
});
