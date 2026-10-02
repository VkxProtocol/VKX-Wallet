# Verifying a VKX Wallet release

This repository and the official website publish the same machine-readable
release record:

- Repository: [`RELEASES.json`](./RELEASES.json)
- Website: [wallet.vkxtech.com.br/releases.json](https://wallet.vkxtech.com.br/releases.json)

The record contains only public identifiers: versions, platform build numbers,
Expo update identifiers and Git commit hashes. It contains no signing keys,
credentials, recovery phrases or private infrastructure details.

## 1. Compare the public records

Download both JSON files and compare the release fields. The app version,
platform builds, production update IDs and public-core commit should match.

The website is the canonical current record. The copy in GitHub makes changes
reviewable in history.

## 2. Test the published security core

Use the `publicCore.commit` value from `RELEASES.json`:

```bash
git clone https://github.com/VkxProtocol/VKX-Wallet.git
cd VKX-Wallet
git checkout 762d018929a988486ffdec74b550c93cfea58cab
npm ci
npm test
```

This checks the published key-generation, address-derivation, encryption and PIN
key-derivation code against the repository's test vectors.

## 3. Compare the installed app

In VKX Wallet, open **Settings → About** and compare the displayed technical
version, build/runtime and update ID with `RELEASES.json`. Store marketing
versions can follow a different numbering scheme; the technical version and
platform build identify the installed binary precisely.

## What this does and does not prove

It verifies that:

- the website and GitHub declare the same production release;
- the public security core exists at a fixed commit and its tests can be run;
- an installed app can be matched to a declared production update ID.

It does **not** prove that the complete application was built from the reported
commit. The full app source is not public, the current bundles were produced
from a modified working tree, and no reproducible-build process, independent
audit or public SBOM is available yet. Those statuses are recorded explicitly
in `RELEASES.json`.

Never send anyone a recovery phrase, private key, PIN or signing credential as
part of verification. Security reports belong at
[security@vkxtech.com.br](mailto:security@vkxtech.com.br).
