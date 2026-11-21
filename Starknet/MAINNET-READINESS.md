# Starknet — Mainnet readiness (2026-11-20)

**Status: prepared for review; mainnet locked** (`STARKNET_MAINNET_RELEASE_APPROVED = false`). No release, no mainnet transaction, no real funds.

## Architecture decision — option C (approved)

OpenZeppelin `AccountUpgradeable` 3.x (`0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381`) is the **default account class on both Sepolia and mainnet**. It is declared on both networks (class hash recomputed from the node's Sierra class; `constructor(public_key)`). The 4.x class used in the first proof of concept (`0x03013bf2…6144`) is not declared on mainnet; it is kept only as a legacy class to recover the existing Sepolia test accounts.

- **Parity:** same phrase, index, class, salt (public key) and constructor calldata → same address on Sepolia and mainnet (tested).
- **Legacy recovery:** an address the account already uses selects its own class; a new account uses 3.x unless only the 4.x variant has on-chain activity (read-only discovery; without network access it never selects legacy). Legacy accounts keep their addresses, balances and signing (tested, and used on-chain to fund the new 3.x accounts).

## Security review of the 3.x class

- Published advisories for `OpenZeppelin/cairo-contracts` (GitHub Security Advisories, checked 2026-11-20): three, all affecting versions `< 0.15.1` (OwnableTwoStep, EthAccount signature bypass, Goerli processing). **None affects 3.x.**
- Upgrades: `upgrade(new_class_hash)` — "The caller is the account contract itself", `new_class_hash` non-zero (3.x API docs). An upgrade therefore needs a transaction signed by the account key.
- Key rotation: `set_public_key(new_public_key, signature)` — only through the account's own `__execute__`, and "the signature must be valid for the new owner".
- 3.x and 4.x expose the same account interface on-chain (`__execute__`, `__validate__`, `__validate_deploy__`, `__validate_declare__`, `is_valid_signature`, `upgrade`, `set_public_key`, `execute_from_outside_v2`, SRC5); the CHANGELOG lists no account security fix between 3.x and 4.x.
- Not a claim that 3.x is safer than 4.x: the choice is pragmatic (already declared on mainnet). Not covered: a formal audit of these classes or of the wallet module; no published key-compromise recovery procedure beyond `set_public_key`.

## Changes in this phase

- Explicit transaction states: `pending`, `confirmed`, `reverted`, `rejected`, `timeout`; only `ACCEPTED_ON_L2/L1` + explicit `SUCCEEDED` is `confirmed`; timeout is never reported as failure nor retried; an unconfirmed deployment blocks the transfer; broadcast failure → `BROADCAST_FAILED`, never re-sent through another node.
- Mainnet candidate: `SN_MAIN`, RPCs zan.top and publicnode (a third public endpoint lacked required methods and was removed), official ETH/STRK, Voyager, OZ 3.x. Locked by a code literal; no environment variable or remote flag can enable it.

## Verification

- 42 core tests (states and negative paths, parity, legacy selection/discovery, legacy signing, locked mainnet, 3.x and 4.x vectors checked against Rust `starknet-core`) + app integration checks.
- Read-only mainnet check (`scripts/starknet-mainnet-readiness.ts`): chain id, tokens and OZ 3.x class OK on both candidate RPCs.
- Sepolia with the default 3.x class: funding from a legacy account [0x0497b7f1…](https://sepolia.voyager.online/tx/0x0497b7f1f4f3d8d15f43e3a2df5e2656412c55b492f5337958ce0b1cc41d78df), deployment [0x07a770ff…](https://sepolia.voyager.online/tx/0x07a770ff61529c1a39fc31ad7964aefc595fc349967c27c9b2b9926ebd665c89), transfer [0x00366e0e…](https://sepolia.voyager.online/tx/0x00366e0e265ac1ad4fb005174ac2d73db29d2ed4da19c57a2cbe048be7c98e71) — all confirmed on two RPC providers; deployed class verified on-chain; both addresses re-derived independently (Python keys + Rust addresses).
- Bundle impact: starknet.js adds ~322 KB minified (~88 KB gzip); no startup cost while the network is disabled.

## Pending before any mainnet test

1. iOS validation on Sepolia (PIN, import, signing, transfer).
2. Third RPC provider (paid) for production redundancy.
3. Independent review (key management, authorization, account deployment, transaction confirmation, upgrades).
4. Release validation: the OTA dry-run test battery passes; the pre-existing native-source guard on `config/googleOAuth.json` is handled by the team's existing release procedure and is unrelated to Starknet.
