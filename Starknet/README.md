# VKX Wallet — Starknet (Sepolia PoC)

Starknet support for VKX Wallet: account derivation from the wallet's BIP39 phrase, local signing, ETH/STRK balances, account deployment and transfers. Testnet only; not enabled in production.

## Files

| Path | Content |
|---|---|
| `src/starknet.ts` | Starknet module used by the app (starknet.js 10.8.0) |
| `tests/starknet-core.spec.ts` | 24 offline tests |
| `scripts/starknet-vectors.ts` | Derivation vectors from the module |
| `scripts/starknet-sepolia-poc.ts` | On-chain run: status, deploy, transfer |
| `reference/python/ref.py` | Independent reference (standard library only) |
| `reference/rust/` | Independent reference (starknet-crypto 0.8.1, starknet-core 0.16.0) |
| `evidence/sepolia-evidence.json` | Recorded on-chain results |

## Design

- Derivation: BIP39 → BIP32 `m/44'/9004'/0'/0/i` → StarkWare key grinding.
- Account: OpenZeppelin `AccountUpgradeable` 4.x, class `0x03013bf2edcf93ac575367eee41cd07bb50e809c78925817b61878db29826144`; salt and constructor argument = public key.
- Transactions V3, fees in STRK, estimated before signing. Mainnet has no RPC configured.

## Derivation vectors

Phrase: `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about` (public BIP39 test phrase).

| i | Stark private key | Public key | Address |
|---|---|---|---|
| 0 | `0x001b8e16cdf31892c56c0370f0e4ca0da096ef4e0c81007b3ba10b11452f8971` | `0x05d97a4a9174d9158c3886717a70112c5e60b17318a1d3ae17f563f1cf8292f4` | `0x04ee2ac5d0f2a340c244235e06d162e7272a938742696cb66f814e1a334c76d2` |
| 1 | `0x06d582b352685f7c37a2faa748536c741c3a8c660cb011bce57457a32cd04d1a` | `0x03810eab057111f997455e907854d499c312910eed85b6597adff08c56e8b5ea` | `0x00cb064ea1d78165d671e1303036a657b197b287481807d1442d10fa1ef52f5b` |
| 2 | `0x02fc51936e38cc0298263303d3a18602f076b1331e5fd239a00c0a91419af398` | `0x0708f3abc86129a3ebd0a34e6637dae2da8a5c7b8d09323b673bb5df19619b6c` | `0x029c0394792551af2120ea912ed40d6bfe32770c0cb9003466479cd18b7b9e21` |

Keys and public keys match the Python reference; public keys and addresses match the Rust reference. A signature from the module verifies with `starknet_crypto::verify`.

## Sepolia transactions (2026-11-20, UTC)

| Operation | Transaction | Block | Result |
|---|---|---|---|
| Faucet → account 0 (100 STRK) | [0x6617848d…95f4c1ff](https://sepolia.voyager.online/tx/0x6617848ddcaba759dc5436861b9b2eb0530d95ee0bc7793da71ad9695f4c1ff) | 18452862 | SUCCEEDED |
| Deploy account 0 | [0x02702376…a335a1f0](https://sepolia.voyager.online/tx/0x02702376439daa9a73ba3cbaacbb5e1709aedc25e04358dee4c1af9ba335a1f0) | 18452889 | SUCCEEDED |
| Transfer 0.1 STRK, account 0 → account 1 | [0x06aa5d2b…bf4d999b](https://sepolia.voyager.online/tx/0x06aa5d2bd471c6f8588510ba55910ab53acb802e83d3bbc330f308edbf4d999b) | 18452899 | SUCCEEDED |

Account 0: `0x0279042774675b647df5f1214bc50584a9c70ffad80cfc52542d43bdc61d0d5d`
Account 1: `0x03577bbaaf5e79c22aec7c10f05c69e62fa94336bbebd8a03b2a3bbb2df5f2e5`

## Run

```sh
npm install
npm test
npm run vectors
python reference/python/ref.py "<phrase>" 0 1 2
cargo run --release --manifest-path reference/rust/Cargo.toml -- key <class_hash> <stark_private_key>
```
