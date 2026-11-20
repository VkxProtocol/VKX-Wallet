# VKX Wallet — Starknet Sepolia Proof of Concept

**Date:** November 20, 2026 · **Network:** Starknet Sepolia (`SN_SEPOLIA`, `0x534e5f5345504f4c4941`) · **Status:** core integration working on-chain; in-app UI is the next milestone.

VKX Wallet is a live self-custodial wallet (React Native / Expo). This PoC adds Starknet support as an isolated module that reuses the wallet's existing BIP39 recovery phrase. Keys are derived and transactions are signed on the device; no backend or custody is involved.

## Technical approach

- **SDK:** official `starknet.js` 10.8.0 (pure JavaScript, no native module).
- **Account contract:** OpenZeppelin `AccountUpgradeable` (cairo-contracts 4.x), class hash `0x03013bf2edcf93ac575367eee41cd07bb50e809c78925817b61878db29826144`, verified on Sepolia (class present, `constructor(public_key)`, hash recomputed from the on-chain Sierra class).
- **Key derivation:** BIP39 → BIP32 `m/44'/9004'/0'/0/i` (SLIP-44 coin type 9004) → StarkWare key grinding → Stark key. Address = `calculateContractAddressFromHash(salt = pubkey, class hash, [pubkey], deployer = 0)`.
- **Independent verification:** derivation, public keys and addresses were cross-checked against two implementations that share no code with starknet.js: a hand-written Python reference (standard library only) and Rust `starknet-crypto 0.8.1` / `starknet-core 0.16.0`. A signature produced by the wallet module was verified with `starknet_crypto::verify`. See `README.md`.
- **Account lifecycle:** counterfactual address can receive funds before deployment; the first outgoing operation sends `DEPLOY_ACCOUNT`, paid in STRK by the account itself.
- **Fees:** V3 transactions paid in STRK; fees are estimated and the balance is checked before anything is signed.
- **Safety:** address validation (range, checksum, rejection of EVM-format addresses), mainnet intentionally disabled in the PoC, broadcast to a single node to avoid duplicates, read fallback across three public RPC nodes, and an automated test asserting no private key ever appears in a network request.
- **Tests:** 24 automated offline tests (derivation, recovery, signing, validation, balances, deploy + send flow, error paths).

## On-chain evidence (Starknet Sepolia)

| Account | Address |
|---|---|
| 0 | `0x0279042774675b647df5f1214bc50584a9c70ffad80cfc52542d43bdc61d0d5d` |
| 1 | `0x03577bbaaf5e79c22aec7c10f05c69e62fa94336bbebd8a03b2a3bbb2df5f2e5` |

| # | Time (UTC) | Operation | Transaction | Block | Result |
|---|---|---|---|---|---|
| 1 | Nov 20 ~22:22 | Receive 100 STRK from the Starknet Foundation faucet → account 0 | [0x6617848d…95f4c1ff](https://sepolia.voyager.online/tx/0x6617848ddcaba759dc5436861b9b2eb0530d95ee0bc7793da71ad9695f4c1ff) | 18452862 | SUCCEEDED · ACCEPTED_ON_L2 |
| 2 | Nov 20 22:24:13 | Deploy account 0 (`DEPLOY_ACCOUNT`, fee 0.0629 STRK) | [0x02702376…a335a1f0](https://sepolia.voyager.online/tx/0x02702376439daa9a73ba3cbaacbb5e1709aedc25e04358dee4c1af9ba335a1f0) | 18452889 | SUCCEEDED · ACCEPTED_ON_L2 |
| 3 | Nov 20 22:24:34 | Transfer 0.1 STRK account 0 → account 1 (`INVOKE` V3, fee 0.0486 STRK) | [0x06aa5d2b…bf4d999b](https://sepolia.voyager.online/tx/0x06aa5d2bd471c6f8588510ba55910ab53acb802e83d3bbc330f308edbf4d999b) | 18452899 | SUCCEEDED · ACCEPTED_ON_L2 |

Receipts were confirmed on two independent RPC providers. Account 1 balance went from 0 to 0.1 STRK. The deployed class of account 0 on-chain is the OpenZeppelin class above. Recovery was confirmed by re-deriving both addresses from the stored test phrase with the independent Python and Rust references.

## Next steps (grant milestones)

1. In-app experience: done on Android (see above); iOS device validation pending.
2. Mainnet enablement after security review.
3. Further Starknet features (tokens, history, ecosystem integrations) as described in the proposal.

## In-app (Android emulator, Hermes, 2026-11-20 UTC)

Starknet Sepolia enabled only by a build-time flag (`EXPO_PUBLIC_STARKNET_NETWORK=sepolia`); no value enables mainnet. Wallets imported by recovery phrase; addresses generated on the device with the PIN and matching the reference vectors.

| Operation | Transaction | Block | Result |
|---|---|---|---|
| Transfer 0.05 STRK, account 0 → account 1 | [0x024023dd…6cc232e](https://sepolia.voyager.online/tx/0x024023dd601c51c28677b45207a3545e4f69b992e3594cd83c8c287e36cc232e) | 18454499 | SUCCEEDED |
| Deploy `0x04ee2ac5…334c76d2` (vector i=0) on its first transfer | [0x02a9f73d…c35c086](https://sepolia.voyager.online/tx/0x02a9f73d9e1cd7e3ddad775f673e9f811cba0413750fd276fd771bf98c35c086) | 18454732 | SUCCEEDED |
| Transfer 0.1 STRK, `0x04ee2ac5…` → account 1 | [0x0111b869…0d6988](https://sepolia.voyager.online/tx/0x0111b8690074f3f731d80b1e5de6edd6f6125b072f1b85681c220c118a0d6988) | 18454736 | SUCCEEDED |

Account 1 balance: 0.10 → 0.15 → 0.25 STRK. Fee and account activation are estimated from public data and confirmed by the user before the PIN; signing happens on the device. Screenshots in `screenshots/`.

