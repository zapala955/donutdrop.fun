import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chooseUsedInvite, type LiveInvite } from '../src/features/invites.js';

/**
 * Invite attribution is an inference, not a fact Discord reports, and the cost of getting it
 * wrong is a named person being credited for — or accused of faking — an invite that was not
 * theirs. So these tests are mostly about the cases where the right answer is "I don't know".
 */

const invite = (code: string, uses: number, inviterId = 'inviter-1'): LiveInvite => ({
  code,
  uses,
  inviterId,
});

describe('choosing the invite that was used', () => {
  it('picks the one counter that moved', () => {
    const before = new Map([
      ['aaa', 4],
      ['bbb', 9],
    ]);
    const used = chooseUsedInvite(before, [invite('aaa', 5), invite('bbb', 9)]);
    assert.equal(used?.code, 'aaa');
  });

  it('carries the inviter through, since that is the whole answer', () => {
    const used = chooseUsedInvite(new Map([['aaa', 0]]), [invite('aaa', 1, 'alice')]);
    assert.equal(used?.inviterId, 'alice');
  });

  it('refuses to choose when two counters moved', () => {
    /* Two joins the queue did not serialise — a restart, most often. Either invite is equally
     * likely to be the one in hand, so picking the first would be a coin flip presented as a
     * fact. The join is recorded as unattributed instead. */
    const before = new Map([
      ['aaa', 1],
      ['bbb', 1],
    ]);
    assert.equal(chooseUsedInvite(before, [invite('aaa', 2), invite('bbb', 2)]), null);
  });

  it('refuses to choose when nothing moved', () => {
    // The invite was deleted between the join and the fetch, or it was the vanity URL.
    const before = new Map([['aaa', 3]]);
    assert.equal(chooseUsedInvite(before, [invite('aaa', 3)]), null);
  });

  it('handles an invite created since the snapshot', () => {
    /* Unseen codes fall back to 0, not to their own count — otherwise a brand-new invite could
     * never register as used, because its count would always equal itself. */
    const used = chooseUsedInvite(new Map([['aaa', 2]]), [invite('aaa', 2), invite('new', 1)]);
    assert.equal(used?.code, 'new');
  });

  it('ignores a new invite nobody has used yet', () => {
    // Created but unused is not a join, and it must not shadow the invite that really moved.
    const used = chooseUsedInvite(new Map([['aaa', 2]]), [invite('aaa', 3), invite('new', 0)]);
    assert.equal(used?.code, 'aaa');
  });

  it('does not treat a deleted invite as the answer', () => {
    /* The deleted code is simply absent from the live list. Nothing moved among what remains, so
     * the result is null rather than the surviving invite by default. */
    const before = new Map([
      ['gone', 7],
      ['aaa', 2],
    ]);
    assert.equal(chooseUsedInvite(before, [invite('aaa', 2)]), null);
  });

  it('is not fooled by a counter that went down', () => {
    // A recreated code reuses the string and restarts at zero. That is not somebody joining.
    assert.equal(chooseUsedInvite(new Map([['aaa', 9]]), [invite('aaa', 0)]), null);
  });

  it('returns nothing when the server has no invites at all', () => {
    assert.equal(chooseUsedInvite(new Map(), []), null);
  });

  it('attributes the first ever join, when the snapshot is empty but an invite exists', () => {
    // The bot primes the snapshot on startup, so an empty map means a genuinely fresh install.
    const used = chooseUsedInvite(new Map(), [invite('aaa', 1, 'bob')]);
    assert.equal(used?.inviterId, 'bob');
  });
});
