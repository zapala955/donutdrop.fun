import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { before, describe, it } from 'node:test';

/* The chat box's slash commands. The placeholder named `/tip` and nothing on the page answered it:
 * no list, no help, and a misspelled or unknown command was posted to everyone as a message. The
 * reader below is run for real, lifted out of chat.js, so what it accepts is what the page sends. */

const frontend = path.resolve(import.meta.dirname, '../../../DONUTDROP FRONTEND/Donut Drop');

type Tip = { player?: string; amountMinor?: number; note?: string; field?: string; error?: string };
let chat = '';
let readTip: (body: string) => Tip;
let argumentAt: (value: string, cmd: { args: unknown[] }) => number;

/** One top-level declaration of chat.js, from its first line to the brace that closes it. */
function lift(name: string): string {
  const start = chat.search(new RegExp(`^(?:const ${name} =|(?:async )?function ${name}\\()`, 'm'));
  assert.ok(start >= 0, `chat.js has no ${name}`);
  const end = chat.startsWith('const', start) ? chat.indexOf(';\n', start) + 2 : chat.indexOf('\n}\n', start) + 3;
  return chat.slice(start, end);
}

before(async () => {
  chat = (await readFile(path.join(frontend, 'assets/js/chat.js'), 'utf8')).replace(/\r\n/g, '\n');
  const util = (await import(pathToFileURL(path.join(frontend, 'assets/js/util.js')).href)) as {
    parseAmount: (input: string) => number | null;
  };
  const body = [lift('TIP_NOTE_MAX'), lift('PLAYER_NAME'), lift('readTip'), lift('argumentAt')].join('\n');
  const made = new Function('parseAmount', `${body}\nreturn { readTip, argumentAt };`)(util.parseAmount) as {
    readTip: typeof readTip;
    argumentAt: typeof argumentAt;
  };
  readTip = made.readTip;
  argumentAt = made.argumentAt;
});

describe('chat commands', () => {
  it('reads a tip to a Java or a Bedrock name, however the phone capitalised it', () => {
    assert.deepEqual(readTip('/tip Steve 5m'), { player: 'Steve', amountMinor: 5_000_000, note: undefined });
    assert.deepEqual(readTip('/tip .Bedrock_Guy 250k gg wp'), {
      player: '.Bedrock_Guy',
      amountMinor: 250_000,
      note: 'gg wp',
    });
    assert.equal(readTip('/Tip Steve 1.5b').amountMinor, 1_500_000_000);
    assert.equal(readTip('/tip @Steve 5m').player, 'Steve');
  });

  it('says which part of a tip is wrong instead of posting it', () => {
    assert.equal(readTip('/tip').field, 'player');
    assert.equal(readTip('/tip Ste-ve 5m').field, 'player');
    assert.equal(readTip('/tip Steve').field, 'amount');
    assert.equal(readTip('/tip Steve lots').field, 'amount');
    assert.equal(readTip('/tip Steve 0').field, 'amount');
    assert.equal(readTip(`/tip Steve 5m ${'x'.repeat(81)}`).field, 'note');
    assert.equal(readTip(`/tip Steve 5m ${'x'.repeat(80)}`).error, undefined);
  });

  it('picks out the argument being typed', () => {
    const tip = { args: [{}, {}, {}] };
    assert.equal(argumentAt('/tip ', tip), 0);
    assert.equal(argumentAt('/tip Ste', tip), 0);
    assert.equal(argumentAt('/tip Steve ', tip), 1);
    assert.equal(argumentAt('/tip Steve 5', tip), 1);
    assert.equal(argumentAt('/tip Steve 5m thanks for the', tip), 2);
  });

  it('never sends a slash line to the chat endpoint', () => {
    const submit = lift('onSubmit');
    const routed = submit.indexOf("body.startsWith('/')");
    assert.ok(
      routed >= 0 && routed < submit.indexOf('sendChat('),
      'every "/" line is a command, handled before the message is sent',
    );
    assert.doesNotMatch(lift('runCommand'), /sendChat\(/);
    // A tip that failed keeps its text, so the name can be fixed rather than typed again.
    assert.match(lift('runCommand'), /if \(await sendTip\([^)]*\)\) \{\n\s*input\.value = '';/);
  });

  it('lists the commands as an accessible combobox over the box', async () => {
    const init = lift('initCommands');
    assert.match(init, /setAttribute\('role', 'combobox'\)/);
    assert.match(init, /setAttribute\('aria-controls', cmdList\.id\)/);
    assert.match(init, /setAttribute\('role', 'listbox'\)/);
    assert.match(lift('commandOption'), /setAttribute\('aria-selected'/);
    assert.match(lift('paintAuthState'), /'Message, or \/ for commands'/);

    const luxe = (await readFile(path.join(frontend, 'assets/css/luxe.css'), 'utf8')).replace(/\r\n/g, '\n');
    assert.match(luxe, /body\.lx \.chat__send \{\s*position: relative;/);
    assert.match(luxe, /body\.lx \.chatcmd\[hidden\] \{ display: none; \}/);
    const calm = [...luxe.matchAll(/@media \(prefers-reduced-motion: reduce\) \{\n([\s\S]*?)\n\}/g)].map((m) => m[1]);
    assert.match(calm.join('\n'), /body\.lx \.chatcmd \{ animation: none; \}/);
    // Options are pressed, so each is a full finger tall.
    assert.match(luxe, /body\.lx \.chatcmd__opt \{[^}]*min-height: 44px;/);
  });
});
