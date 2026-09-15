# VKX Wallet — encryption core

> **Scope:** this repository is **not** the full wallet application. It holds the
> two modules that protect your keys on the device. Everything else — the
> interface, routing, payment rails — is not here. See
> [What is not here](#what-is-not-here).

This repository holds the part of [VKX Wallet](https://wallet.vkxtech.com.br)
that protects your keys while they sit on your device: the encryption at rest,
and the key-derivation function that turns your PIN into an encryption key.

We publish it so the claims on our
[security page](https://wallet.vkxtech.com.br/wallet-security) can be checked
rather than trusted.

```bash
npm install
npm test
```

Both suites run in plain Node. No device, no emulator.

---

## What is here

| File | Role |
| --- | --- |
| `src/scryptProvider.ts` | Derives the encryption key from the PIN using scrypt. Uses a native implementation when one is present and proven correct against a test vector, and JavaScript otherwise. |
| `src/cryptoEnvelope.ts` | Encrypts and decrypts a secret with AES-256-GCM, storing the KDF parameters inside the encrypted file. |

These are the files that ship in the app, copied at the commit listed at the
bottom. They were not rewritten for publication.

Their comments are in Portuguese, the working language of our team. We left them
as they are, because they are the comments the app actually carries.

## What is not here

This repository is not the wallet.

The routing engine, fee logic, payment rails and partner integrations are not
included. None of them take part in protecting your keys.

Key generation and address derivation (BIP-39 and BIP-44) are also absent, and
that one is a real gap. They live in a file that depends on the React Native
runtime, so this repository cannot load or test it. Shipping code that nobody
can run proves nothing, so it stays out until it can be tested here.

We have not been audited by a third party. When that happens, the report goes on
the security page, findings included.

---

## Where to start reading

### `tests/scrypt-vectors.spec.ts` — does the KDF match the standard?

Everything rests on one assumption: that the key protecting an encrypted private
key comes from real scrypt, as specified, and not from something that resembles
it.

The suite checks the published vector from RFC 7914 §12, plus three properties a
subtly broken implementation would fail:

- The synchronous and asynchronous paths return the same bytes. Async exists so
  the interface stays responsive; if it changed the result, one PIN would produce
  two different keys.
- Native and JavaScript backends agree. Backend selection is a performance
  decision. If it were also a correctness decision, an app update could lock
  someone out of their own wallet.
- `N`, `r` and the salt all change the output, so a weakened parameter cannot
  pass unnoticed.

### `tests/envelope-policy.spec.ts` — is the cost high enough, and stable?

A 6-digit PIN has a million combinations. If an encrypted file is ever pulled
off a device, the scrypt cost is the only thing between that file and the
recovery phrase.

- The floor, `N=4096`, cannot be lowered.
- The strong parameter, `N=32768`, uses eight times the memory of the floor.
  Memory is what makes a parallel attack expensive rather than merely slow.
- Decryption reads parameters from the envelope, not from current settings. This
  is what makes raising the cost safe: an older file keeps opening.
- Every encryption uses a fresh random salt and nonce.
- A wrong PIN and a tampered authentication tag are both rejected.

---

## Why two parameter sets

`N=32768` costs 32 MiB per attempt and is the level recommended for interactive
use. It applies when a native implementation is available.

In pure JavaScript the same parameter measured over 20 seconds on a mid-range
Android device, which is not a usable unlock. The JavaScript path therefore stays
at the `N=4096` floor.

Migration only moves upward. A payload already encrypted with the stronger
parameter is never rewritten with the weaker one. We added that rule after
finding our own migration routine doing exactly that; it is recorded in the fix
history on the security page.

## Reporting a problem

Found a flaw here? Tell us before publishing it: **[security@vkxtech.com.br](mailto:security@vkxtech.com.br)**.

Response times and our commitment not to pursue good-faith research are on the
[security page](https://wallet.vkxtech.com.br/wallet-security#disclosure).

## Provenance

Mirrored from the VKX Wallet application at commit `b4bc9e4`, 15 September 2026.

## License

MIT. See [LICENSE](./LICENSE).
