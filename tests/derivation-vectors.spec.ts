// tests/derivation-vectors.spec.ts
//
// Does VKX derive the same addresses as everyone else?
//
// This is the test that decides whether the promise on our security page holds:
// that your 12 words restore your funds in any compatible wallet, today or in
// ten years, even if VKX disappears. If our derivation drifted from the
// standard by one path component, that promise would be false — and nobody
// would notice until someone tried to recover elsewhere.
//
// The mnemonic below is the one BIP-39 itself uses for test vectors. It is
// public, it holds no funds, and it must never be used for a real wallet.

import assert from 'node:assert/strict';
import { deriveAddressesFromMnemonic, deriveAddressesFromMnemonicAtIndex } from '../src/keygen';

const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const derived = await deriveAddressesFromMnemonic(TEST_MNEMONIC);

// ── Published references ────────────────────────────────────────────────────
// These two are not values we recorded from our own output. They are published
// outside this project, and anyone can look them up.

// BIP-84, "Test vectors" — first receiving address for this mnemonic.
assert.equal(
  derived.btc,
  'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  'Bitcoin address does not match the BIP-84 test vector'
);

// The address this mnemonic produces at m/44'/60'/0'/0/0 in every Ethereum
// wallet, and the one used in countless test fixtures.
assert.equal(
  derived.evm,
  '0x9858EfFD232B4033E47d90003D41EC34EcaEda94',
  'Ethereum address does not match the standard derivation for this mnemonic'
);

// ── Cross-checkable references ──────────────────────────────────────────────
// Import the mnemonic above into any wallet using the same paths and you get
// these. They are here so a change in path or curve cannot pass silently.

assert.equal(
  derived.tron,
  'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH',
  "TRON address changed — check the m/44'/195' path"
);

assert.equal(
  derived.sol,
  'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
  "Solana address changed — check the ed25519 m/44'/501' derivation"
);

// ── EVM chains share one address ────────────────────────────────────────────
// They share a curve and a derivation path, so they must share the address.
// If one drifted, funds would be sent to an address the user cannot open on
// that chain.
for (const chain of ['bsc', 'eth', 'arb', 'base', 'matic'] as const) {
  assert.equal(
    derived[chain],
    derived.evm,
    `${chain} must resolve to the same address as the EVM account`
  );
}

// ── Account index changes the address, and only the address ────────────────
// The wallet supports multiple accounts from one phrase. Index 1 has to be a
// different account on every chain — if any of them ignored the index, two
// accounts would silently share funds.
{
  const second = await deriveAddressesFromMnemonicAtIndex(TEST_MNEMONIC, 1);

  assert.notEqual(second.evm, derived.evm, 'account index 1 must differ on EVM');
  assert.notEqual(second.btc, derived.btc, 'account index 1 must differ on Bitcoin');
  assert.notEqual(second.tron, derived.tron, 'account index 1 must differ on TRON');
  assert.notEqual(second.sol, derived.sol, 'account index 1 must differ on Solana');

  // Still the same wallet: the first account must not have moved.
  const again = await deriveAddressesFromMnemonic(TEST_MNEMONIC);
  assert.equal(again.evm, derived.evm, 'derivation must be deterministic');
  assert.equal(again.btc, derived.btc, 'derivation must be deterministic');
}

// ── An invalid phrase must fail, not improvise ─────────────────────────────
// BIP-39 has a checksum. A phrase that fails it is a typo, and returning some
// address anyway would send a user's funds somewhere they can never recover.
{
  const wrong = await deriveAddressesFromMnemonic(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'
  );
  assert.ok(
    !wrong.evm && !wrong.btc && !wrong.sol,
    'a mnemonic failing the BIP-39 checksum must not produce addresses'
  );
}

console.log('derivation-vectors.spec passed');
