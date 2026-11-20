# Starknet — Mainnet readiness (Phase 3, 2026-11-20)

**Status: prepared for review; mainnet locked.** No release, no mainnet transaction, no real funds.

## Open decision

The account class used on Sepolia (OpenZeppelin `AccountUpgradeable` 4.x, `0x03013bf2…6144`) is **not declared on mainnet**. OpenZeppelin 3.x (`0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381`) is declared on **both** networks (class hash recomputed from the node's Sierra class, `constructor(public_key)`). The code now selects the account class per network: Sepolia 4.x (existing evidence), mainnet candidate 3.x. Since the class is part of the address, mainnet and Sepolia addresses differ for the same phrase unless one class is used on both.

## Changes

- Explicit transaction states: `pending`, `confirmed`, `reverted`, `rejected`, `timeout`. Only `ACCEPTED_ON_L2/L1` with an explicit `SUCCEEDED` execution status is `confirmed`; a missing execution status stays `pending`. `wait: false` returns `pending`. A timeout is not reported as a failure (the transaction may still land) and is never retried automatically. An unconfirmed account deployment blocks the following transfer.
- Broadcast failures return `BROADCAST_FAILED` and are never re-sent through another node.
- Mainnet candidate configuration (`SN_MAIN`, two verified public RPCs, official ETH/STRK, Voyager, OZ 3.x). It is used only if the code constant `STARKNET_MAINNET_RELEASE_APPROVED` is changed to `true` in a reviewed release; no environment variable or remote flag can enable it. While `false`, mainnet has no RPC and every call fails with `NETWORK_DISABLED` before any request.
- EVM-format addresses (`0x` + 40 hex) remain rejected as Starknet recipients.

## Verification

- 37 core tests (status classification, pending/timeout/rejected paths, deploy-without-confirmation, broadcast failure without re-send, serialized concurrent sends, locked mainnet, OZ 3.x vectors checked against Rust `starknet-core`) + app integration checks.
- Read-only mainnet check (`scripts/starknet-mainnet-readiness.ts`): zan.top and publicnode return `SN_MAIN`, official ETH/STRK (18 decimals) and the declared OZ 3.x class. A third public endpoint lacked required methods and was removed; a paid provider is recommended as a third RPC before release.
- OZ 3.x end-to-end on Sepolia: [funding](https://sepolia.voyager.online/tx/0x06e56d1eac31973427bf2fdfe3e8713c5400d3696d730ea587d10969a46ab139), [deployment](https://sepolia.voyager.online/tx/0x06b50cd79ec6229244d2a469191bebabb4068f2309fdf418200438bdbd9629f6), [transfer](https://sepolia.voyager.online/tx/0x04c37860334abf98f8562a5ee37a06323c54d06cfd4ff7d82f073f545a7f810c) — all `confirmed`; deployed class verified on-chain.
- Bundle impact: starknet.js adds ~322 KB minified (~88 KB gzip); no startup cost while the network is disabled (module loaded lazily).

## Pending before mainnet

1. Account class decision (above).
2. iOS validation on Sepolia.
3. Third (paid) RPC provider.
4. Independent review of the module.
