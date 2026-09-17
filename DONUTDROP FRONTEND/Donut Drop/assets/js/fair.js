/* fair.js — the provably fair verification hub.
 *
 * The commitment scheme: the server hashes a secret seed and publishes the hash BEFORE you play.
 * After the round it reveals the seed. Re-hash it yourself and it must match the hash you were
 * given, which proves the seed was fixed before the roll rather than chosen to beat you.
 *
 * This page does the re-hash in the browser using SubtleCrypto, so the check does not depend on
 * trusting the same server the check is auditing. The replay of the roll itself goes to
 * /v1/fairness/verify because the HMAC construction lives there — but the hash comparison, which
 * is the part that catches a cheating house, is computed locally and independently.
 */
import { state, bus, verifyFairness, upgradeHistory } from './store.js';
import { $, el, money, pct } from './util.js';
import { toast } from './ui.js';

let root = null;

export function mountFair(view) {
  root = $('#fairRoot', view);
  if (!root) return;
  if (!root.dataset.built) {
    root.dataset.built = '1';
    bus.addEventListener('change', () => {
      if (root.isConnected) paintCommitment();
    });
  }
  paint();
}

function paint() {
  root.innerHTML = `
    <section class="fairhead glass">
      <div class="fairhead__main">
        <span class="fairhead__label">Active commitment</span>
        <b class="fairhead__hash mono" id="fairHash">—</b>
        <span class="fairhead__sub mono" id="fairSub">published before the roll</span>
      </div>
      <dl class="fairhead__facts mono">
        <div><dt>Nonce</dt><dd id="fairNonce">—</dd></div>
        <div><dt>Algorithm</dt><dd id="fairAlgo">HMAC-SHA256</dd></div>
      </dl>
    </section>

    <section class="card">
      <h2 class="card__h">Verify a round
        <button class="ihint" type="button"
          aria-label="The hash comparison runs in your browser, not on the server being audited."
          data-tip="The hash comparison runs in your browser, not on the server being audited."></button>
      </h2>
      <div class="verify">
        <label class="verify__field">
          <span>Server seed (revealed)</span>
          <input class="mono" id="vSeed" placeholder="64 hex characters" autocomplete="off" spellcheck="false">
        </label>
        <label class="verify__field">
          <span>Server seed hash (committed)</span>
          <input class="mono" id="vHash" placeholder="64 hex characters" autocomplete="off" spellcheck="false">
        </label>
        <label class="verify__field">
          <span>Client seed</span>
          <input class="mono" id="vClient" placeholder="your client seed" autocomplete="off" spellcheck="false">
        </label>
        <label class="verify__field verify__field--short">
          <span>Nonce</span>
          <input class="mono" id="vNonce" inputmode="numeric" placeholder="0" autocomplete="off">
        </label>
        <button class="btn btn--go verify__go" id="vGo" type="button">Verify</button>
      </div>
      <div class="verify__out" id="vOut" hidden></div>
    </section>

    <section class="card">
      <h2 class="card__h">Your recent rounds <span>newest first</span></h2>
      <button class="btn" id="fairLoad" type="button">Load my rounds</button>
      <div class="roundlist" id="fairRounds"></div>
    </section>`;

  paintCommitment();
  $('#vGo', root).addEventListener('click', runVerification);
  $('#fairLoad', root).addEventListener('click', loadRounds);
}

function paintCommitment() {
  if (!root?.isConnected) return;
  const hash = $('#fairHash', root);
  const nonce = $('#fairNonce', root);
  const algo = $('#fairAlgo', root);
  if (!hash) return;

  if (!state.authenticated || !state.fairness) {
    hash.textContent = 'Log in to see your commitment';
    nonce.textContent = '—';
    return;
  }
  hash.textContent = state.fairness.serverSeedHash;
  nonce.textContent = String(state.fairness.nonce);
  algo.textContent = state.fairness.algorithm || 'HMAC-SHA256-v1';
}

/** SHA-256 in the browser. This is the independent half of the check. */
async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function runVerification() {
  const button = $('#vGo', root);
  const out = $('#vOut', root);
  const seed = $('#vSeed', root).value.trim().toLowerCase();
  const committed = $('#vHash', root).value.trim().toLowerCase();
  const clientSeed = $('#vClient', root).value.trim();
  const nonce = Number($('#vNonce', root).value.trim() || '0');

  if (!/^[a-f0-9]{64}$/.test(seed)) {
    return showVerdict(out, 'bad', 'That server seed is not 64 hex characters.');
  }
  if (committed && !/^[a-f0-9]{64}$/.test(committed)) {
    return showVerdict(out, 'bad', 'That commitment hash is not 64 hex characters.');
  }
  if (!clientSeed) {
    return showVerdict(out, 'bad', 'Enter the client seed the round used.');
  }
  if (!Number.isInteger(nonce) || nonce < 0) {
    return showVerdict(out, 'bad', 'The nonce must be a whole number, zero or above.');
  }

  button.disabled = true;
  try {
    // The local check first: does the revealed seed actually produce the committed hash?
    const recomputed = await sha256Hex(seed);
    const commitmentOk = committed ? recomputed === committed : null;

    const result = await verifyFairness(seed, clientSeed, nonce);
    const serverAgrees = result.serverSeedHash === recomputed;
    const roll = Number(result.rollPpm ?? result.roll_ppm ?? 0);

    const rows = [
      ['Recomputed hash', recomputed],
      committed ? ['Commitment', commitmentOk ? 'MATCHES — the seed was fixed in advance' : 'DOES NOT MATCH'] : null,
      ['Server agrees on hash', serverAgrees ? 'yes' : 'no'],
      ['Roll', `${(roll / 10_000).toFixed(4)}%`],
      ['Digest', result.digest ?? '—'],
    ].filter(Boolean);

    const verdict = commitmentOk === false || !serverAgrees ? 'bad' : 'good';
    out.hidden = false;
    out.dataset.verdict = verdict;
    out.innerHTML = `
      <b class="verify__verdict">${
        verdict === 'good'
          ? (commitmentOk === null
              ? 'Roll reproduced. Add the commitment hash to prove it was fixed beforehand.'
              : 'Verified. The seed matches the commitment and the roll reproduces exactly.')
          : 'Verification FAILED. Do not trust this round.'
      }</b>
      <dl class="verify__rows mono">
        ${rows.map(([key, value]) => `<div><dt>${escapeText(key)}</dt><dd>${escapeText(value)}</dd></div>`).join('')}
      </dl>`;
  } catch (error) {
    showVerdict(out, 'bad', error?.message || 'The verification request failed.');
  } finally {
    button.disabled = false;
  }
}

function showVerdict(out, verdict, message) {
  out.hidden = false;
  out.dataset.verdict = verdict;
  out.innerHTML = `<b class="verify__verdict">${escapeText(message)}</b>`;
}

async function loadRounds() {
  const mount = $('#fairRounds', root);
  const button = $('#fairLoad', root);
  if (!state.authenticated) {
    toast({ kind: 'lose', title: 'Log in first', body: 'Round history is tied to your account.' });
    return;
  }
  button.disabled = true;
  try {
    const result = await upgradeHistory(25);
    const rounds = result.rounds || [];
    if (!rounds.length) {
      mount.innerHTML = '<p class="empty">No rounds yet. Play one and it will appear here.</p>';
      return;
    }
    mount.innerHTML = '';
    rounds.forEach((round) => {
      const row = el('article', 'roundrow');
      row.dataset.outcome = round.outcome;
      const chance = Number(round.chance_ppm ?? 0) / 1_000_000;
      row.innerHTML = `
        <span class="roundrow__out">${round.outcome === 'win' ? 'WIN' : 'LOSS'}</span>
        <span class="roundrow__meta">
          <b>${escapeText(round.display_name ?? 'Round')}</b>
          <em class="mono">${pct(chance, 2)} · nonce ${round.nonce}</em>
        </span>
        <span class="roundrow__val mono">${round.payout_minor ? '+' + money(Number(round.payout_minor)) : money(-Number(round.stake_value_minor ?? 0))}</span>
        <button class="btn btn--tiny roundrow__use" type="button">Use</button>`;
      row.querySelector('.roundrow__use').addEventListener('click', () => {
        $('#vSeed', root).value = round.server_seed_reveal ?? '';
        $('#vHash', root).value = round.server_seed_hash ?? '';
        $('#vClient', root).value = round.client_seed ?? '';
        $('#vNonce', root).value = String(round.nonce ?? 0);
        $('#vSeed', root).scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      mount.appendChild(row);
    });
  } catch (error) {
    toast({
      kind: 'lose',
      title: 'Could not load rounds',
      body: error?.message || 'The server rejected the request.',
    });
  } finally {
    button.disabled = false;
  }
}

function escapeText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
