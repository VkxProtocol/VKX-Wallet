# VKX Wallet — Multichain Integration Overview

Self-custody, sponsored execution and fiat access in one wallet.

A technical reference for ecosystem teams, integration partners and reviewers. This document connects the public encryption core with the wallet’s production infrastructure, without publishing proprietary application code.

Verified snapshot: 3 November 2026. Configuration can change.

## Sponsored transactions across five networks

Production configuration enables EVM paymasters on BNB Smart Chain, Base, Arbitrum One and Polygon PoS, plus a Solana fee payer. The four enabled EVM v0.8 paymasters were checked using eth_chainId and eth_getCode: the chain IDs matched and each address returned deployed bytecode.

- BNB Smart Chain (56): Enabled, subject to eligibility. [Paymaster](https://bscscan.com/address/0x39F01976686b906E1c6B0D243cB9dc1a33D21106).
- Ethereum (1): Disabled. [Paymaster](https://etherscan.io/address/0xCbAC92a70fb50ab97990774566D50949Ada0bB3d).
- Base (8453): Enabled, subject to eligibility. [Paymaster](https://basescan.org/address/0x7Bd2024cAd405ccA960fE9989334A70153c41682).
- Arbitrum One (42161): Enabled, subject to eligibility. [Paymaster](https://arbiscan.io/address/0xA6283Ae08849E1B2a10EF0204541c4B0f5C48b5F).
- Polygon PoS (137): Enabled, subject to eligibility. [Paymaster](https://polygonscan.com/address/0x6a2dA242B0eEbc17706B9A046c6AA5ef37bDEc01).
- Solana: Fee payer enabled. [Fee payer](https://solscan.io/account/2C8Kxe2rZhAgfu6zTgiQPrtDHANaJVq8tij7YnPxrMb5).

Gasless describes who pays the network fee, not the absence of fees. Eligibility depends on the operation, account, native balance, policy limits and sponsor funding. Native-asset transfers, arbitrary dApp calls and every swap are not automatically covered. Ethereum has deployed infrastructure but sponsorship is currently disabled. No sponsorship is claimed here for Bitcoin, TRON or Robinhood.

## How execution is separated from ownership

- **User device:** Generates and protects keys; signs the requested operation.
- **VKX services:** Check eligibility and construct the supported route. EVM paths include account abstraction and eligible native-gas top-ups.
- **Network settlement:** EVM bundler / EntryPoint and paymaster, or Solana co-signing with a designated fee payer. Confirmation is reconciled with the network.

## Fiat access: Transak and Pix

Transak is integrated as the card on-ramp partner. The wallet requests coverage and quotes, prepares a hosted checkout, and supports direct delivery or supported swap / bridge delivery routes. Apple Pay and Google Pay depend on the country, device and provider eligibility. Order tracking uses webhook events and reconciliation. KYC, fees, asset coverage and payment methods are determined for the selected route.

Pix uses the XGate integration for BRL payments and VKX delivery orchestration. At this snapshot, the API advertised purchases on Polygon, BSC, Ethereum, Base, Robinhood and Solana; sales also included TRON. Arbitrum was not in the advertised Pix list, so this page does not claim a currently available direct Pix–Arbitrum purchase. Token restrictions, liquidity and regional checks still apply.

Cross-chain delivery and funding use route-specific integrations, including deBridge, LI.FI, Across and CCTP where supported. Provider integration is not a guarantee that every pair or network is available at every moment.

## Arbitrum funding and copy trading

The implemented trading integration targets native USDC on Arbitrum One (chain 42161). The wallet prepares funding, consolidates supported assets when required, and exposes strategy subscriptions, top-ups, withdrawals and position history. The integration connects to the trading provider and Hyperliquid execution; using Arbitrum for funding does not mean derivative trades execute on Arbitrum.

Trading configuration and account-specific actions require authentication. This publication describes the reviewed implementation; it does not publish customer positions, returns, assets under management or a claim of universally available strategies.

## What reviewers can verify now

- Open the paymaster links above and inspect code and public activity in the corresponding explorer. A deployed contract proves deployment, not adoption or the outcome of every transaction.
- Download the dated evidence JSON and compare it with the public configuration endpoints. The snapshot is a point-in-time observation, not a live uptime guarantee.
- Review the MIT-licensed encryption core: scrypt PIN derivation, AES-256-GCM envelopes, key generation and derivation tests. The public repository is not the full wallet, payment backend or routing engine.
- Read the security model and responsible disclosure process. An independent audit report and reproducible full-app builds are not currently published.

[GitHub](https://github.com/VkxProtocol/VKX-Wallet) · [Evidence JSON](https://wallet.vkxtech.com.br/wallet-integrations-evidence.json) · [Security](https://wallet.vkxtech.com.br/wallet-security)

## Usage metrics and sample transactions

No user count, transaction volume or TVL is inferred from enabled networks, contract deployment or catalog size. No customer payment is published as a promotional example. Infrastructure references above are public; reconciled usage metrics and consented transaction case studies can supplement this document when available.

## Integration references

Transak: card on-ramp integration. XGate: Brazilian Pix rail. deBridge, LI.FI, Across and CCTP: route-dependent infrastructure. Mira / Hyperliquid: trading integration and execution. These descriptions identify technical roles; they do not imply endorsement of VKX by every listed organization.
