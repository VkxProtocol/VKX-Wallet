import { gcm } from '@noble/ciphers/aes';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils';
import { deriveScryptKeyAsync, deriveScryptKeySync, getScryptBackend } from './scryptProvider';
import { Buffer } from 'buffer';

// Legacy parameters used by old wallet payloads.
export const SCRYPT_PARAMS_V1_LEGACY = {
  N: 32768,
  r: 8,
  p: 1,
  dkLen: 32,
} as const;

// Piso seguro para o caminho JS. Mantido porque, sem scrypt nativo, custo maior
// torna o desbloqueio inviável (medido no aparelho: 6,4s já em N=4096).
export const SCRYPT_PARAMS_V1 = {
  N: 4096,
  r: 8,
  p: 1,
  dkLen: 32,
} as const;

// Parâmetro FORTE, usado quando o scrypt nativo está verificado.
//
// POR QUE IMPORTA: o segredo protegido é um PIN de 6 dígitos — 1 milhão de
// combinações. Se o blob cifrado for extraído (aparelho com root, malware com
// acesso ao keychain, backup, extração forense), quebrar o PIN devolve as 12
// palavras e, com elas, os fundos em qualquer aparelho. Não é uma tela de
// bloqueio: é a senha mestra.
//
// Medido (JS, desktop): N=4096 -> 24ms / 4 MiB; N=32768 -> 79ms / 32 MiB. O
// tempo cresce 3,3x, mas a MEMÓRIA cresce 8x — e é a memória que inviabiliza
// ataque paralelo em GPU. Com o nativo o custo no aparelho cai para centenas
// de ms, então dá para pagar.
export const SCRYPT_PARAMS_STRONG = {
  N: 32768,
  r: 8,
  p: 1,
  dkLen: 32,
} as const;

/**
 * Parâmetros para NOVAS cifragens. Decifrar nunca depende desta escolha: os
 * parâmetros viajam dentro do próprio envelope (`kdf`), então payload antigo
 * continua abrindo com os parâmetros dele.
 */
export const getPreferredScryptParams = (): ScryptEnvelopeParams => {
  try {
    if (getScryptBackend() === 'native') return { ...SCRYPT_PARAMS_STRONG };
  } catch {
    // Sem provedor: fica no piso.
  }
  return { ...SCRYPT_PARAMS_V1 };
};

const SCRYPT_LIMITS = {
  minN: 4096,
  maxN: 32768,
  minR: 8,
  maxR: 16,
  minP: 1,
  maxP: 2,
  dkLen: 32,
} as const;

const AES_GCM_NONCE_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;
const SCRYPT_SALT_MIN_LENGTH = 16;

export interface EncryptedEnvelopeV1 {
  v: 1;
  alg: 'aes-256-gcm';
  kdf: {
    name: 'scrypt';
    N: number;
    r: number;
    p: number;
    dkLen: number;
    salt_b64u: string;
  };
  nonce_b64u: string;
  ciphertext_b64u: string;
  tag_b64u: string;
}

export type ScryptEnvelopeParams = {
  N: number;
  r: number;
  p: number;
  dkLen: number;
};

const getRandomBytes = (length: number): Uint8Array => {
  const out = new Uint8Array(length);
  const rng = (globalThis as any)?.crypto?.getRandomValues;
  if (typeof rng !== 'function') {
    throw new Error('CRYPTO_RNG_UNAVAILABLE');
  }
  rng.call((globalThis as any).crypto, out);
  return out;
};

export const toBase64UrlNoPadding = (bytes: Uint8Array): string =>
  Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

export const fromBase64UrlNoPadding = (value: string): Uint8Array => {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Uint8Array.from(Buffer.from(normalized + padding, 'base64'));
};

export const isBase64UrlNoPadding = (value: string): boolean =>
  typeof value === 'string' && value.length > 0 && /^[A-Za-z0-9\-_]+$/.test(value);

const isPowerOfTwo = (value: number): boolean =>
  Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;

const isValidKdfParams = (kdf: any): boolean => {
  if (!kdf || typeof kdf !== 'object') return false;
  if (kdf.name !== 'scrypt') return false;

  const N = Number(kdf.N);
  const r = Number(kdf.r);
  const p = Number(kdf.p);
  const dkLen = Number(kdf.dkLen);

  if (!isPowerOfTwo(N)) return false;
  if (N < SCRYPT_LIMITS.minN || N > SCRYPT_LIMITS.maxN) return false;
  if (!Number.isInteger(r) || r < SCRYPT_LIMITS.minR || r > SCRYPT_LIMITS.maxR) return false;
  if (!Number.isInteger(p) || p < SCRYPT_LIMITS.minP || p > SCRYPT_LIMITS.maxP) return false;
  if (dkLen !== SCRYPT_LIMITS.dkLen) return false;

  return true;
};

const deriveKeyWithParams = (
  pin: string,
  salt: Uint8Array,
  params: { N: number; r: number; p: number; dkLen: number }
): Uint8Array => deriveScryptKeySync(utf8ToBytes(pin), salt, params);

/**
 * Mesma derivação, mesmos parâmetros, mesma saída — mas devolvendo o controle
 * pra thread JS a cada `asyncTick` ms enquanto trabalha.
 *
 * POR QUE EXISTE: `scrypt()` é CPU síncrona e trava a thread inteira enquanto
 * roda. Com os parâmetros legados (N=32768) isso dá 3-4 segundos em que o app
 * não processa NENHUM toque — o usuário toca "voltar", nada acontece, e parece
 * que travou. É o sintoma de "congela por poucos segundos e normaliza".
 *
 * O tempo total NÃO diminui, e isso é proposital: o custo do scrypt é o que
 * protege um PIN de 6 dígitos (só 1 milhão de combinações — com KDF rápido,
 * força bruta em cima do arquivo cifrado seria trivial). Baixar N deixaria o
 * app mais rápido enfraquecendo exatamente a defesa que importa. O que muda
 * aqui é só QUEM segura a thread: a UI continua respondendo durante o cálculo.
 */
const deriveKeyWithParamsAsync = async (
  pin: string,
  salt: Uint8Array,
  params: { N: number; r: number; p: number; dkLen: number }
): Promise<Uint8Array> => deriveScryptKeyAsync(utf8ToBytes(pin), salt, params);

export const encryptStringToEnvelope = (
  plaintext: string,
  pin: string,
  aad?: Uint8Array,
  params: ScryptEnvelopeParams = getPreferredScryptParams()
): EncryptedEnvelopeV1 => {
  if (!pin || typeof pin !== 'string') throw new Error('PIN_INVALID');
  if (!isValidKdfParams({ name: 'scrypt', ...params })) throw new Error('ENVELOPE_KDF_INVALID');
  const salt = getRandomBytes(SCRYPT_SALT_MIN_LENGTH);
  const nonce = getRandomBytes(AES_GCM_NONCE_LENGTH);
  const key = deriveKeyWithParams(pin, salt, params);
  try {
    const cipher = gcm(key, nonce, aad);
    const encrypted = cipher.encrypt(utf8ToBytes(plaintext));
    const ciphertext = encrypted.subarray(0, Math.max(0, encrypted.length - AES_GCM_TAG_LENGTH));
    const tag = encrypted.subarray(Math.max(0, encrypted.length - AES_GCM_TAG_LENGTH));

    return {
      v: 1,
      alg: 'aes-256-gcm',
      kdf: {
        name: 'scrypt',
        N: params.N,
        r: params.r,
        p: params.p,
        dkLen: params.dkLen,
        salt_b64u: toBase64UrlNoPadding(salt),
      },
      nonce_b64u: toBase64UrlNoPadding(nonce),
      ciphertext_b64u: toBase64UrlNoPadding(ciphertext),
      tag_b64u: toBase64UrlNoPadding(tag),
    };
  } finally {
    key.fill(0);
  }
};

export const parseEncryptedEnvelope = (raw: string): EncryptedEnvelopeV1 | null => {
  if (!raw || typeof raw !== 'string') return null;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || parsed.v !== 1 || parsed.alg !== 'aes-256-gcm') return null;
  if (!isValidKdfParams(parsed.kdf)) return null;

  if (
    !isBase64UrlNoPadding(parsed.kdf.salt_b64u) ||
    !isBase64UrlNoPadding(parsed.nonce_b64u) ||
    !isBase64UrlNoPadding(parsed.ciphertext_b64u) ||
    !isBase64UrlNoPadding(parsed.tag_b64u)
  ) {
    return null;
  }

  return parsed as EncryptedEnvelopeV1;
};

/**
 * Validação + decodificação do envelope, compartilhada pelas versões síncrona
 * e assíncrona. Extraída pra que as duas não possam divergir: a única
 * diferença entre elas deve ser QUAL derivação de chave é chamada.
 */
const prepareEnvelopeDecryption = (envelope: EncryptedEnvelopeV1, pin: string) => {
  if (!pin || typeof pin !== 'string') throw new Error('PIN_INVALID');
  const salt = fromBase64UrlNoPadding(envelope.kdf.salt_b64u);
  const nonce = fromBase64UrlNoPadding(envelope.nonce_b64u);
  const ciphertext = fromBase64UrlNoPadding(envelope.ciphertext_b64u);
  const tag = fromBase64UrlNoPadding(envelope.tag_b64u);

  if (salt.length < SCRYPT_SALT_MIN_LENGTH) throw new Error('ENVELOPE_SALT_INVALID');
  if (nonce.length !== AES_GCM_NONCE_LENGTH) throw new Error('ENVELOPE_NONCE_INVALID');
  if (tag.length !== AES_GCM_TAG_LENGTH) throw new Error('ENVELOPE_TAG_INVALID');
  if (!isValidKdfParams(envelope.kdf)) throw new Error('ENVELOPE_KDF_INVALID');

  return {
    salt,
    nonce,
    ciphertext,
    tag,
    params: {
      N: Number(envelope.kdf.N),
      r: Number(envelope.kdf.r),
      p: Number(envelope.kdf.p),
      dkLen: Number(envelope.kdf.dkLen),
    },
  };
};

const finishEnvelopeDecryption = (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  tag: Uint8Array,
  aad?: Uint8Array
): string => {
  try {
    const cipher = gcm(key, nonce, aad);
    const merged = new Uint8Array(ciphertext.length + tag.length);
    merged.set(ciphertext, 0);
    merged.set(tag, ciphertext.length);
    const decrypted = cipher.decrypt(merged);
    return bytesToUtf8(decrypted);
  } finally {
    key.fill(0);
  }
};

export const decryptEnvelopeToString = (
  envelope: EncryptedEnvelopeV1,
  pin: string,
  aad?: Uint8Array
): string => {
  const prepared = prepareEnvelopeDecryption(envelope, pin);
  const key = deriveKeyWithParams(pin, prepared.salt, prepared.params);
  return finishEnvelopeDecryption(key, prepared.nonce, prepared.ciphertext, prepared.tag, aad);
};

/**
 * Idêntica à versão síncrona em entrada, saída e erros — só não trava a UI.
 * É o que deve ser usado em qualquer caminho onde o usuário está olhando pra
 * tela (abrir carteira, assinar). Ver deriveKeyWithParamsAsync.
 */
export const decryptEnvelopeToStringAsync = async (
  envelope: EncryptedEnvelopeV1,
  pin: string,
  aad?: Uint8Array
): Promise<string> => {
  const prepared = prepareEnvelopeDecryption(envelope, pin);
  const key = await deriveKeyWithParamsAsync(pin, prepared.salt, prepared.params);
  return finishEnvelopeDecryption(key, prepared.nonce, prepared.ciphertext, prepared.tag, aad);
};
