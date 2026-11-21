# VKX Wallet — Starknet

Starknet support for VKX Wallet: account derivation from the wallet's BIP39 phrase, local signing, ETH/STRK balances, account deployment and transfers. Tested on Sepolia; mainnet is locked in code and not enabled for users.

## Files

| Path | Content |
|---|---|
| `src/starknet.ts` | Starknet module used by the app (starknet.js 10.8.0) |
| `tests/starknet-core.spec.ts` | 42 offline tests |
| `scripts/starknet-vectors.ts` | Derivation vectors from the module |
| `scripts/starknet-sepolia-poc.ts` | On-chain run: status, deploy, transfer (`--legado` for 4.x accounts) |
| `scripts/starknet-mainnet-readiness.ts` | Read-only mainnet configuration check |
| `reference/python/ref.py` | Independent reference (standard library only) |
| `reference/rust/` | Independent reference (starknet-crypto 0.8.1, starknet-core 0.16.0) |
| `evidence/` | Recorded on-chain results and mainnet readiness check |
| `screenshots/` | In-app flow on Android |
| `REPORT.md` | Proof-of-concept report |
| `MAINNET-READINESS.md` | Mainnet readiness (mainnet locked) |
| `LICENSE` | MIT, this directory only |

## Design

- Derivation: BIP39 → BIP32 `m/44'/9004'/0'/0/i` → StarkWare key grinding.
- **Account class (architecture decision, 2026-11-20):** OpenZeppelin `AccountUpgradeable` 3.x, `0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381`, on **both** Sepolia and mainnet (declared on both). The same phrase, index, class, salt (public key) and constructor calldata give the same address on both networks.
- **Legacy:** OpenZeppelin 4.x, `0x03013bf2edcf93ac575367eee41cd07bb50e809c78925817b61878db29826144`, Sepolia-only. Kept only to recover the earlier proof-of-concept accounts. An address already used by the account selects its class; a new account uses 3.x unless only the 4.x variant has on-chain activity (read-only discovery).
- Transactions V3, fees in STRK, estimated before signing. States: `pending`, `confirmed`, `reverted`, `rejected`, `timeout`.
- Mainnet locked by a code constant (`STARKNET_MAINNET_RELEASE_APPROVED = false`). See `MAINNET-READINESS.md`.

## Derivation vectors

Phrase: `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about` (public BIP39 test phrase; its accounts are test-only and must never hold real funds).

| i | Stark private key | Public key | Address (3.x, default) | Address (4.x, legacy) |
|---|---|---|---|---|
| 0 | `0x001b8e16cdf31892c56c0370f0e4ca0da096ef4e0c81007b3ba10b11452f8971` | `0x05d97a4a9174d9158c3886717a70112c5e60b17318a1d3ae17f563f1cf8292f4` | `0x02000ba5ba904aed0858233e8f782bbc07fd31298824074e05a871f28642342c` | `0x04ee2ac5d0f2a340c244235e06d162e7272a938742696cb66f814e1a334c76d2` |
| 1 | `0x06d582b352685f7c37a2faa748536c741c3a8c660cb011bce57457a32cd04d1a` | `0x03810eab057111f997455e907854d499c312910eed85b6597adff08c56e8b5ea` | `0x01bb6a88898af0b5a40b60654ba38c802790d27aecbb34483ff1a91c7584a683` | `0x00cb064ea1d78165d671e1303036a657b197b287481807d1442d10fa1ef52f5b` |
| 2 | `0x02fc51936e38cc0298263303d3a18602f076b1331e5fd239a00c0a91419af398` | `0x0708f3abc86129a3ebd0a34e6637dae2da8a5c7b8d09323b673bb5df19619b6c` | `0x04521d736e74420c14b90e6c9ad74c073c84174b75c51038f9333cf9d32b904c` | `0x029c0394792551af2120ea912ed40d6bfe32770c0cb9003466479cd18b7b9e21` |

Keys and public keys match the Python reference; public keys and addresses (both classes) match the Rust reference. A signature from the module verifies with `starknet_crypto::verify`.

## Sepolia transactions (2026-11-20 UTC)

**Default class 3.x**

| Operation | Transaction | Block | Result |
|---|---|---|---|
| Funding 2 STRK from a legacy 4.x account | [0x0497b7f1…41d78df](https://sepolia.voyager.online/tx/0x0497b7f1f4f3d8d15f43e3a2df5e2656412c55b492f5337958ce0b1cc41d78df) | 18456112 | confirmed |
| Deploy `0x002ca0c3…290fcae` (3.x) on its first transfer | [0x07a770ff…bd665c89](https://sepolia.voyager.online/tx/0x07a770ff61529c1a39fc31ad7964aefc595fc349967c27c9b2b9926ebd665c89) | 18456126 | confirmed |
| Transfer 0.1 STRK → `0x001be169…2185422f` (3.x) | [0x00366e0e…7c98e71](https://sepolia.voyager.online/tx/0x00366e0e265ac1ad4fb005174ac2d73db29d2ed4da19c57a2cbe048be7c98e71) | 18456130 | confirmed |
| Deploy `0x01114046…73520483` (3.x, index 2) | [0x06b50cd7…dbd9629f6](https://sepolia.voyager.online/tx/0x06b50cd79ec6229244d2a469191bebabb4068f2309fdf418200438bdbd9629f6) | — | confirmed |
| Transfer 0.05 STRK from it | [0x04c37860…5a7f810c](https://sepolia.voyager.online/tx/0x04c37860334abf98f8562a5ee37a06323c54d06cfd4ff7d82f073f545a7f810c) | 18455369 | confirmed |

**Legacy class 4.x (proof of concept, kept)**

| Operation | Transaction | Block | Result |
|---|---|---|---|
| Faucet → `0x02790427…c61d0d5d` (100 STRK) | [0x6617848d…95f4c1ff](https://sepolia.voyager.online/tx/0x6617848ddcaba759dc5436861b9b2eb0530d95ee0bc7793da71ad9695f4c1ff) | 18452862 | SUCCEEDED |
| Deploy `0x02790427…c61d0d5d` | [0x02702376…a335a1f0](https://sepolia.voyager.online/tx/0x02702376439daa9a73ba3cbaacbb5e1709aedc25e04358dee4c1af9ba335a1f0) | 18452889 | SUCCEEDED |
| Transfer 0.1 STRK | [0x06aa5d2b…bf4d999b](https://sepolia.voyager.online/tx/0x06aa5d2bd471c6f8588510ba55910ab53acb802e83d3bbc330f308edbf4d999b) | 18452899 | SUCCEEDED |
| In-app transfer 0.05 STRK (Android, PIN) | [0x024023dd…6cc232e](https://sepolia.voyager.online/tx/0x024023dd601c51c28677b45207a3545e4f69b992e3594cd83c8c287e36cc232e) | 18454499 | SUCCEEDED |
| In-app deploy `0x04ee2ac5…334c76d2` on its first transfer | [0x02a9f73d…c35c086](https://sepolia.voyager.online/tx/0x02a9f73d9e1cd7e3ddad775f673e9f811cba0413750fd276fd771bf98c35c086) | 18454732 | SUCCEEDED |
| In-app transfer 0.1 STRK | [0x0111b869…0d6988](https://sepolia.voyager.online/tx/0x0111b8690074f3f731d80b1e5de6edd6f6125b072f1b85681c220c118a0d6988) | 18454736 | SUCCEEDED |

Deployed classes verified on-chain (3.x accounts report `0x01d1777d…`, legacy accounts `0x03013bf2…`). In-app screenshots in `screenshots/` (legacy 4.x accounts; the app keeps using an account's existing address).

## Run

```sh
npm install
npm test
npm run vectors
python reference/python/ref.py "<phrase>" 0 1 2
cargo run --release --manifest-path reference/rust/Cargo.toml -- key <class_hash> <stark_private_key>
```
