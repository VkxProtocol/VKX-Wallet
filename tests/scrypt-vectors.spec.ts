// tests/scrypt-vectors.spec.ts
//
// Standards conformance for the key-derivation function.
//
// This is the test an auditor should run first. Everything else in the wallet
// rests on one assumption: that the key protecting your encrypted private key
// is derived by real scrypt, exactly as specified — not by something that
// merely looks like it.
//
// The vector below is published in RFC 7914, section 12. If our derivation
// produced anything else, every encrypted payload the wallet ever wrote would
// be incompatible with the standard, and the cost we claim to impose on an
// attacker would be unverifiable.

import assert from 'node:assert/strict';
import { deriveScryptKeySync, deriveScryptKeyAsync, getScryptBackend } from '../src/scryptProvider';

const bytes = (text: string) => new TextEncoder().encode(text);
const hex = (input: Uint8Array) => Buffer.from(input).toString('hex');

// ── RFC 7914 §12, second vector ─────────────────────────────────────────────
//   scrypt("password", "NaCl", N=1024, r=8, p=16, dkLen=64)
const VECTOR = {
  password: 'password',
  salt: 'NaCl',
  params: { N: 1024, r: 8, p: 16, dkLen: 64 },
  expected:
    'fdbabe1c9d3472007856e7190d01e9fe' +
    '7c6ad7cbc8237830e77376634b373162' +
    '2eaf30d92e22a3886ff109279d9830da' +
    'c727afb94a83ee6d8360cbdfa2cc0640',
};

// ── 1. The synchronous path matches the RFC ─────────────────────────────────
{
  const out = deriveScryptKeySync(bytes(VECTOR.password), bytes(VECTOR.salt), VECTOR.params);
  assert.equal(
    hex(out),
    VECTOR.expected,
    'synchronous derivation does not match RFC 7914 — every encrypted payload would be non-standard'
  );
}

// ── 2. The asynchronous path produces the SAME bytes ───────────────────────
// The wallet uses the async path on the hot path (unlock, send, swap) so the
// interface stays responsive. Async is an execution detail: it must never
// change the result.
{
  const out = await deriveScryptKeyAsync(bytes(VECTOR.password), bytes(VECTOR.salt), VECTOR.params);
  assert.equal(
    hex(out),
    VECTOR.expected,
    'asynchronous derivation diverges from the synchronous one — the same PIN would yield two different keys'
  );
}

// ── 3. Whichever backend is selected, the answer is the same ───────────────
// The provider prefers a native implementation when one is present and proven,
// and falls back to JavaScript otherwise. That choice is a performance
// decision; it cannot be a correctness decision, or a user could be locked out
// of their own wallet by an app update.
{
  const backend = getScryptBackend();
  assert.ok(
    backend === 'native' || backend === 'js',
    `unexpected backend: ${backend}`
  );
  const out = deriveScryptKeySync(bytes(VECTOR.password), bytes(VECTOR.salt), VECTOR.params);
  assert.equal(
    hex(out),
    VECTOR.expected,
    `backend "${backend}" does not agree with RFC 7914`
  );
  console.log(`  backend in use: ${backend}`);
}

// ── 4. Cost parameters actually change the output ──────────────────────────
// Guards against an implementation that silently ignores N, r or p — which
// would let a weakened parameter pass unnoticed while appearing to work.
{
  const base = deriveScryptKeySync(bytes('pin'), bytes('0123456789abcdef'), {
    N: 1024, r: 8, p: 1, dkLen: 32,
  });
  const strongerN = deriveScryptKeySync(bytes('pin'), bytes('0123456789abcdef'), {
    N: 4096, r: 8, p: 1, dkLen: 32,
  });
  const strongerR = deriveScryptKeySync(bytes('pin'), bytes('0123456789abcdef'), {
    N: 1024, r: 16, p: 1, dkLen: 32,
  });
  assert.notEqual(hex(base), hex(strongerN), 'changing N must change the derived key');
  assert.notEqual(hex(base), hex(strongerR), 'changing r must change the derived key');
}

// ── 5. Salt separates users ────────────────────────────────────────────────
// Without this property, one precomputed table would cover every user sharing
// the same PIN — and a 6-digit PIN has only a million possibilities.
{
  const a = deriveScryptKeySync(bytes('123456'), bytes('aaaaaaaaaaaaaaaa'), { N: 1024, r: 8, p: 1, dkLen: 32 });
  const b = deriveScryptKeySync(bytes('123456'), bytes('bbbbbbbbbbbbbbbb'), { N: 1024, r: 8, p: 1, dkLen: 32 });
  assert.notEqual(hex(a), hex(b), 'the same PIN with different salts must derive different keys');
}

console.log('scrypt-vectors.spec passed');
