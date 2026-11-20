// scripts/starknet-vectors.ts — imprime os vetores da derivação Starknet da VKX
// calculados pelo módulo do app (ethers + starknet.js), para comparar com as
// referências independentes (Python e Rust) em README.md.
// Usa SOMENTE a frase PÚBLICA de teste do BIP39 ("abandon ×11 about"), que
// nunca deve receber fundos. Não imprime nada de carteira real.
// Rodar: npx tsx scripts/starknet-vectors.ts
import { HDNodeWallet } from 'ethers';
import {
  OZ_ACCOUNT_CLASS_HASH,
  deriveStarknetAccountFromMnemonic,
  signStarknetHash,
  starknetDerivationPath,
} from '../src/starknet';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
console.log(`class_hash;${OZ_ACCOUNT_CLASS_HASH}`);
for (const i of [0, 1, 2]) {
  const bip32 = HDNodeWallet.fromPhrase(PHRASE, undefined, starknetDerivationPath(i)).privateKey;
  const a = deriveStarknetAccountFromMnemonic(PHRASE, i);
  console.log(`${i};${a.derivationPath};${bip32};${a.privateKey};${a.publicKey};${a.address}`);
}
const a0 = deriveStarknetAccountFromMnemonic(PHRASE, 0);
const msg = '0x' + 'ab'.repeat(31);
const sig = signStarknetHash(a0.privateKey, msg);
console.log(`sig;${a0.publicKey};${msg};${sig.r};${sig.s}`);
