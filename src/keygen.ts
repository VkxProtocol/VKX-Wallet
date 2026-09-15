// src/services/keygen.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONLY DIFFERENCE FROM THE FILE THAT SHIPS IN THE APP
//
// The application imports `react-native-get-random-values` here. That package
// installs `crypto.getRandomValues` on React Native, which has no native one.
// It is a side-effect import: it adds the CSPRNG and exports nothing.
//
// Node already provides `crypto.getRandomValues`, and the package cannot be
// loaded outside React Native. Importing it here would make this file
// impossible to load or test, which would defeat the purpose of publishing it.
//
// The guard below keeps the app's behaviour identical — on React Native the
// polyfill still loads — while letting the file run under Node. Everything
// below this block is byte-for-byte the file in the app.
// ─────────────────────────────────────────────────────────────────────────────
// Second (and last) difference: React Native's bundler provides `require` to
// every module. Node does not, inside an ES module — so the lazy `require(...)`
// calls further down, which load the heavier chain libraries only when needed,
// would silently return nothing here and every address would come back empty.
// This restores `require` with the standard Node helper. No derivation logic
// changes.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

if (typeof (globalThis as any).crypto?.getRandomValues !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  require('react-native-get-random-values');
}
import { Buffer } from 'buffer';

import * as bip39 from 'bip39';
import { hmac } from '@noble/hashes/hmac';
import { sha512 } from '@noble/hashes/sha512';
import { sha256 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/ripemd160';
import { keccak_256 } from '@noble/hashes/sha3';
import { utf8ToBytes } from '@noble/hashes/utils';
import { Keypair } from '@solana/web3.js';

// LAZY LOADING LIBRARIES
let _bitcoinLib: any = null;
let _bip32Lib: any = null;
let _eccLib: any = null;

const getEcc = () => {
  if (!_eccLib) {
    _eccLib = require('@bitcoinerlab/secp256k1');
  }
  return _eccLib;
};

const getBitcoin = () => {
  if (!_bitcoinLib) {
    _bitcoinLib = require('bitcoinjs-lib');
    _bitcoinLib.initEccLib(getEcc());
  }
  return _bitcoinLib;
};

const getBip32 = () => {
  if (!_bip32Lib) {
    const { BIP32Factory } = require('bip32');
    _bip32Lib = BIP32Factory(getEcc());
  }
  return _bip32Lib;
};

export interface DerivedAddresses {
  btc: string;
  tron?: string;
  sol?: string;
  bsc?: string;
  eth?: string;
  arb?: string;
  base?: string;
  matic?: string;
  evm?: string;
}

const normalizeDerivationIndex = (index?: number): number => {
  const parsed = Number(index);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

const HARDENED_OFFSET = 0x80000000;

function deriveEd25519Path(path: string, seed: Uint8Array): Uint8Array {
  if (!path.startsWith('m')) {
    throw new Error('Invalid derivation path');
  }

  let i = hmac(sha512, utf8ToBytes('ed25519 seed'), seed);
  // Ensure i is defined
  if (!i) throw new Error('HMAC generation failed');
  
  let key = i.slice(0, 32);
  let chainCode = i.slice(32);

  const segments = path.split('/').slice(1);
  for (const segment of segments) {
    if (!segment) continue;
    const hardened = segment.endsWith("'");
    if (!hardened) {
      throw new Error('Non-hardened derivation is not supported for ed25519');
    }

    const indexStr = segment.slice(0, -1);
    const index = Number(indexStr);
    if (!Number.isFinite(index)) {
      throw new Error('Invalid derivation path segment');
    }

    const idx = (index + HARDENED_OFFSET) >>> 0;
    const data = new Uint8Array(1 + 32 + 4);
    data[0] = 0;
    data.set(key, 1);
    data[33] = (idx >>> 24) & 0xff;
    data[34] = (idx >>> 16) & 0xff;
    data[35] = (idx >>> 8) & 0xff;
    data[36] = idx & 0xff;

    i = hmac(sha512, chainCode, data);
    key = i.slice(0, 32);
    chainCode = i.slice(32);
  }

  return key;
}

const toCompressedSecpPublicKey = (publicKeyHex: string): string | undefined => {
  try {
    const normalized = String(publicKeyHex || '').replace(/^0x/i, '');
    const raw = Buffer.from(normalized, 'hex');
    if (raw.length === 33) {
      return `0x${raw.toString('hex')}`;
    }
    if (raw.length === 65 && raw[0] === 0x04) {
      const x = raw.subarray(1, 33);
      const y = raw.subarray(33, 65);
      const prefix = (y[y.length - 1] & 1) === 1 ? 0x03 : 0x02;
      return `0x${Buffer.concat([Buffer.from([prefix]), x]).toString('hex')}`;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

export const deriveBtcSegwitAddressFromCompressedPubKey = (compressedPubKeyHex: string): string | undefined => {
  try {
    const normalized = String(compressedPubKeyHex || '').replace(/^0x/i, '');
    const pubkey = Buffer.from(normalized, 'hex');
    if (pubkey.length !== 33) return undefined;

    const hash160 = ripemd160(sha256(pubkey));
    const { bech32 } = require('bech32');
    const words = bech32.toWords(Buffer.from(hash160));
    words.unshift(0); // witness version 0
    return bech32.encode('bc', words);
  } catch {
    return undefined;
  }
};

export const deriveBitcoinAddressFromPrivateKeyHex = (privateKeyHex: string): string | undefined => {
  try {
    const normalized = String(privateKeyHex || '').replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(normalized)) return undefined;
    const privateKey = Buffer.from(normalized, 'hex');
    const publicKey = getEcc().pointFromScalar(privateKey, true);
    if (!publicKey) return undefined;
    return deriveBtcSegwitAddressFromCompressedPubKey(Buffer.from(publicKey).toString('hex'));
  } catch {
    return undefined;
  }
};

export const deriveTronAddressFromPrivateKeyHex = (privateKeyHex: string): string | undefined => {
  try {
    const TronWebLib = require('tronweb');
    const TronWebCtor = TronWebLib?.TronWeb || TronWebLib?.default || TronWebLib;
    const tw = new TronWebCtor({ fullHost: 'https://api.trongrid.io' });
    const addrResult = tw.address.fromPrivateKey(String(privateKeyHex || '').replace(/^0x/i, ''));
    const address = typeof addrResult === 'string' ? addrResult : addrResult?.base58;
    if (address) return address;
  } catch {}

  try {
    const normalizedPk = String(privateKeyHex || '').replace(/^0x/i, '');
    const privateKey = Buffer.from(normalizedPk, 'hex');
    if (privateKey.length !== 32) return undefined;

    const ecc = getEcc();
    const publicKey = ecc.pointFromScalar(privateKey, false);
    if (!publicKey || publicKey.length < 65) return undefined;

    const publicKeyNoPrefix = publicKey.slice(1); // 64 bytes
    const digest = keccak_256(publicKeyNoPrefix);
    const payload = new Uint8Array(21);
    payload[0] = 0x41; // Tron mainnet prefix
    payload.set(digest.slice(-20), 1);

    const checksum1 = sha256(payload);
    const checksum2 = sha256(checksum1);
    const checksum = checksum2.slice(0, 4);

    const full = new Uint8Array(25);
    full.set(payload, 0);
    full.set(checksum, 21);

    const bs58Lib = require('bs58');
    const encode = bs58Lib?.default?.encode || bs58Lib?.encode;
    if (typeof encode !== 'function') return undefined;
    return encode(Buffer.from(full));
  } catch {
    return undefined;
  }
};

/**
 * Deriva endereços de múltiplas cadeias a partir do mnemônico e índice HD.
 */
export async function deriveAddressesFromMnemonicAtIndex(
  mnemonic: string,
  derivationIndex: number = 0
): Promise<DerivedAddresses> {
  try {
    if (!bip39.validateMnemonic(mnemonic)) {
      throw new Error('Mnemônico inválido');
    }

    const index = normalizeDerivationIndex(derivationIndex);
    const deriveHdWalletAtPath = (path: string): any | null => {
      try {
        const { HDNodeWallet } = require('ethers');
        return HDNodeWallet.fromPhrase(mnemonic.trim(), undefined, path);
      } catch {
        return null;
      }
    };

    const deriveEvmAddress = (): string | undefined => {
      try {
        const path = `m/44'/60'/0'/0/${index}`;
        const evmWallet = deriveHdWalletAtPath(path);
        return evmWallet?.address;
      } catch {
        return undefined;
      }
    };

    const evmDefault = deriveEvmAddress();
    let btcAddress = '';
    let tronAddress = '';
    let solAddress = '';

    // 1) Bitcoin (native SegWit bc1...) via Ethers HD path + bech32 encoding.
    try {
      const btcWallet = deriveHdWalletAtPath(`m/84'/0'/0'/0/${index}`);
      const publicKeyHex =
        (btcWallet as any)?.signingKey?.compressedPublicKey ||
        (btcWallet as any)?.compressedPublicKey ||
        (btcWallet as any)?.publicKey ||
        '';
      const compressed = toCompressedSecpPublicKey(publicKeyHex);
      btcAddress = (compressed && deriveBtcSegwitAddressFromCompressedPubKey(compressed)) || '';
    } catch {}

    // Legacy BTC fallback (bip32 + bitcoinjs-lib) for compatibility.
    if (!btcAddress) {
      try {
        // SÍNCRONO: ver comentário em wallet.ts. A versão async do PBKDF2 cede
        // ao event loop por iteração e vira ~51s de relógio para ~200ms de CPU.
        // Este caminho roda no LOGIN (deriva BTC/TRON/SOL), então o custo async
        // aparecia como app "pensando" na entrada.
        const seed = bip39.mnemonicToSeedSync(mnemonic);
        const root = getBip32().fromSeed(seed);
        const bitcoin = getBitcoin();
        const btcPath = `m/84'/0'/0'/0/${index}`;
        const btcChild = root.derivePath(btcPath);
        const built = bitcoin.payments.p2wpkh({
          pubkey: btcChild.publicKey,
          network: bitcoin.networks.bitcoin,
        });
        btcAddress = built?.address || '';
      } catch {}
    }

    // 2) Tron via dedicated HD path.
    try {
      const tronWallet = deriveHdWalletAtPath(`m/44'/195'/0'/0/${index}`);
      const pkHex = String((tronWallet as any)?.privateKey || '').replace(/^0x/i, '');
      if (pkHex) {
        tronAddress = deriveTronAddressFromPrivateKeyHex(pkHex) || '';
      }
    } catch {}

    // 3) Solana via ed25519 derivation (independent from secp/bip32).
    try {
      // SÍNCRONO pelo mesmo motivo do BTC acima.
      const seed = bip39.mnemonicToSeedSync(mnemonic);
      const seedBytes = Uint8Array.from(seed);
      const derivedKey = deriveEd25519Path(`m/44'/501'/${index}'/0'`, seedBytes);
      const keypair = Keypair.fromSeed(derivedKey);
      solAddress = keypair.publicKey.toBase58();
    } catch {}

    return {
      btc: btcAddress || '',
      tron: tronAddress || undefined,
      sol: solAddress || undefined,
      evm: evmDefault,
      bsc: evmDefault,
      eth: evmDefault,
      arb: evmDefault,
      base: evmDefault,
      matic: evmDefault,
    };
  } catch (error) {
    console.error('[KeyGen] Erro na derivação de chaves:', error);
    return { btc: '' };
  }
}

/**
 * Mantido por compatibilidade com código existente (índice 0).
 */
export async function deriveAddressesFromMnemonic(mnemonic: string): Promise<DerivedAddresses> {
  return deriveAddressesFromMnemonicAtIndex(mnemonic, 0);
}
