// tests/envelope-policy.spec.ts
//
// Trava a política de KDF da cifragem em repouso.
//
// O QUE ESTÁ EM JOGO: o segredo protegido é um PIN de 6 dígitos — 1 milhão de
// combinações. Se o blob cifrado for extraído (root, malware com acesso ao
// keychain, backup, extração forense), quebrar o PIN devolve as 12 palavras e,
// com elas, os fundos em qualquer aparelho. O custo do scrypt é a ÚNICA coisa
// entre o blob e a seed.
//
// Medido (JS, desktop): N=4096 -> 24ms / 4 MiB; N=32768 -> 79ms / 32 MiB.

import assert from 'node:assert/strict';
import {
  SCRYPT_PARAMS_V1,
  SCRYPT_PARAMS_STRONG,
  encryptStringToEnvelope,
  decryptEnvelopeToString,
  parseEncryptedEnvelope,
} from '../src/cryptoEnvelope';

// ── 1. O piso JS nunca pode cair ────────────────────────────────────────────
// 4096 já é o mínimo aceitável para um segredo de 6 dígitos. Abaixo disso, a
// força bruta do PIN sai de horas para minutos.
assert.equal(SCRYPT_PARAMS_V1.N, 4096, 'piso do KDF não pode ser reduzido');
assert.ok(SCRYPT_PARAMS_V1.r >= 8, 'r < 8 derruba a dureza de memória');
assert.equal(SCRYPT_PARAMS_V1.dkLen, 32, 'chave AES-256 exige 32 bytes');

// ── 2. O parâmetro forte é o recomendado para uso interativo ────────────────
assert.equal(SCRYPT_PARAMS_STRONG.N, 32768, 'parâmetro forte deve ser 2^15');
assert.ok(
  SCRYPT_PARAMS_STRONG.N >= SCRYPT_PARAMS_V1.N * 8,
  'o ganho do forte vem da memória: 8x o piso'
);

// ── 3. Decifrar usa os parâmetros DO ENVELOPE, não os atuais ───────────────
// É isto que torna a migração segura: payload antigo continua abrindo depois de
// mudarmos o padrão. Sem esta propriedade, subir o N trancaria todo mundo fora
// da própria carteira.
{
  const PIN = '123456';
  const segredo = 'abandon abandon abandon abandon abandon abandon';

  const fraco = encryptStringToEnvelope(segredo, PIN, undefined, { ...SCRYPT_PARAMS_V1 });
  const forte = encryptStringToEnvelope(segredo, PIN, undefined, { ...SCRYPT_PARAMS_STRONG });

  assert.equal(fraco.kdf.N, 4096, 'envelope deve registrar o N usado');
  assert.equal(forte.kdf.N, 32768);

  assert.equal(
    decryptEnvelopeToString(fraco, PIN),
    segredo,
    'payload no piso tem de continuar abrindo'
  );
  assert.equal(
    decryptEnvelopeToString(forte, PIN),
    segredo,
    'payload forte tem de abrir'
  );
}

// ── 4. Cada cifragem usa sal novo ───────────────────────────────────────────
// Sal repetido permitiria tabela pré-computada para os mesmos 1 milhão de PINs
// e anularia o custo do scrypt.
{
  const a = encryptStringToEnvelope('x', '123456');
  const b = encryptStringToEnvelope('x', '123456');
  assert.notEqual(a.kdf.salt_b64u, b.kdf.salt_b64u, 'sal deve ser aleatório por payload');
  assert.notEqual(a.ciphertext_b64u, b.ciphertext_b64u);
  assert.notEqual(a.nonce_b64u, b.nonce_b64u, 'nonce do AES-GCM nunca pode repetir');
}

// ── 5. PIN errado não abre ──────────────────────────────────────────────────
{
  const env = encryptStringToEnvelope('segredo', '123456');
  assert.throws(
    () => decryptEnvelopeToString(env, '654321'),
    'PIN errado tem de falhar na autenticação do AES-GCM'
  );
}

// ── 6. Envelope adulterado não abre (AEAD de verdade) ──────────────────────
{
  const env = encryptStringToEnvelope('segredo', '123456');
  const adulterado = parseEncryptedEnvelope(
    JSON.stringify({ ...env, tag_b64u: env.tag_b64u.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) })
  );
  assert.ok(adulterado, 'envelope adulterado ainda deve ser reconhecido como envelope');
  assert.throws(
    () => decryptEnvelopeToString(adulterado!, '123456'),
    'tag alterada tem de ser rejeitada'
  );
}

console.log('envelope-policy.spec passed');
