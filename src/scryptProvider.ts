import { scrypt as nobleScrypt, scryptAsync as nobleScryptAsync } from '@noble/hashes/scrypt';

/**
 * Escolhe QUEM deriva a chave: o scrypt nativo (OpenSSL via JSI) quando ele
 * existe e está PROVADO correto, ou o `@noble/hashes` em JS.
 *
 * Por que existe
 * --------------
 * Hermes não tem JIT, então scrypt em JS puro custa ~10-20x o nativo. Com
 * N=16384 (envelope da chave pós-quântica) isso é ~1,5-2s de CPU. Nativo é da
 * ordem de 100-150ms. Não dá pra baixar o N: o custo é justamente o que protege
 * um PIN de 6 dígitos.
 *
 * A regra de segurança que manda aqui
 * -----------------------------------
 * scrypt é padrão: mesmos (senha, salt, N, r, p, dkLen) produzem os MESMOS
 * bytes em qualquer implementação. Só que "deveria" não basta quando o erro é
 * o usuário não conseguir abrir a carteira. Então o nativo só entra em serviço
 * depois de passar num vetor de teste contra o `@noble`, verificado aqui em
 * tempo de execução. Qualquer coisa fora do esperado — módulo ausente, API
 * diferente, um byte divergente, exceção — derruba o nativo de forma
 * permanente na sessão e tudo segue no `@noble`.
 *
 * Isso também é o que torna seguro embarcar esta troca num bundle OTA: se o
 * binário instalado não tiver o módulo nativo, o require falha, o fallback
 * assume e nada muda para o usuário.
 */

type ScryptParams = { N: number; r: number; p: number; dkLen: number };

/**
 * Assinatura no estilo Node: `(password, salt, keylen, options)`.
 * NÃO é `(password, salt, N, r, p, dkLen)` — errar isso passa `N` como keylen
 * e `r` como objeto de opções, e o resultado é lixo ou exceção.
 */
type NativeScryptSync = (
  password: Uint8Array,
  salt: Uint8Array,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => ArrayBuffer | Uint8Array;

/**
 * `maxmem` do quick-crypto tem default de 32 MiB e ele rejeita quando
 * `128 * r * N` ultrapassa. Com o parâmetro legado (N=32768, r=8) a conta dá
 * exatamente 33.554.432 — encostado no limite. Damos folga para não depender
 * de um `>` virar `>=` em alguma versão.
 */
const NATIVE_MAXMEM_BYTES = 256 * 1024 * 1024;

// Vetor de teste da RFC 7914 (seção 12), o caso "password"/"NaCl".
// Parâmetros pequenos de propósito: a verificação roda uma vez e não pode
// custar caro. O que importa é provar que a implementação é a mesma função.
const RFC7914_VECTOR = {
  password: 'password',
  salt: 'NaCl',
  N: 1024,
  r: 8,
  p: 16,
  dkLen: 64,
};

let nativeScrypt: NativeScryptSync | null = null;
let nativeState: 'unchecked' | 'verified' | 'unavailable' = 'unchecked';

const callNative = (
  fn: NativeScryptSync,
  password: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams
): Uint8Array =>
  toBytes(
    fn(password, salt, params.dkLen, {
      N: params.N,
      r: params.r,
      p: params.p,
      maxmem: NATIVE_MAXMEM_BYTES,
    })
  );

const toBytes = (value: ArrayBuffer | Uint8Array): Uint8Array =>
  value instanceof Uint8Array ? value : new Uint8Array(value);

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

/**
 * O caminho nativo é OPT-IN EXPLÍCITO, e por padrão fica DESLIGADO.
 *
 * POR QUÊ: `react-native-quick-crypto` está no package.json, então o Metro o
 * coloca no bundle OTA mesmo dentro do try/catch abaixo. Se o BINÁRIO instalado
 * não tiver o módulo nativo correspondente, a falha não chega necessariamente
 * como exceção de JS — o `require` entra no NitroModules e o app pode morrer
 * inteiro, sem redbox e sem erro capturável. "Só engorda o bundle" estava
 * errado.
 *
 * O mesmo padrão já existe em multichainDerivation.ts
 * (EXPO_PUBLIC_NATIVE_DERIVATION_ANDROID): módulo nativo só entra em serviço
 * quando o build declara que ele está lá.
 *
 * Para reativar: `EXPO_PUBLIC_NATIVE_SCRYPT=1` + **build nativo novo** com o
 * pod do quick-crypto. Nunca num ciclo só-OTA.
 */
const parseEnvBool = (value: any): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

/**
 * Leitura PREGUIÇOSA da flag, em cache.
 *
 * Era uma IIFE no topo do módulo com `import Constants from 'expo-constants'`
 * estático — e isso arrastava o React Native só para LER o módulo. Consequência
 * prática: `cryptoEnvelope` (que depende daqui) não podia ser importado num
 * teste de Node, ou seja, o núcleo de criptografia era o único código do app
 * que NÃO tinha teste unitário possível. Justamente o que uma auditoria vai
 * querer ver rodando.
 *
 * Fora do app (teste, script) não há `expo-constants`: o require falha, cai no
 * catch e o resultado é `false` — o mesmo padrão conservador de antes.
 */
let nativeScryptEnabledCache: boolean | null = null;

const isNativeScryptEnabled = (): boolean => {
  if (nativeScryptEnabledCache !== null) return nativeScryptEnabledCache;
  let habilitado = false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Constants = require('expo-constants')?.default ?? require('expo-constants');
    const extra = (Constants?.expoConfig?.extra ?? (Constants as any)?.manifest?.extra ?? {}) as Record<
      string,
      string | undefined
    >;
    habilitado =
      parseEnvBool(extra.EXPO_PUBLIC_NATIVE_SCRYPT) ||
      parseEnvBool(process.env.EXPO_PUBLIC_NATIVE_SCRYPT);
  } catch {
    habilitado = parseEnvBool(process.env.EXPO_PUBLIC_NATIVE_SCRYPT);
  }
  nativeScryptEnabledCache = habilitado;
  return habilitado;
};

/**
 * `require` preguiçoso dentro de try/catch: o pacote é dependência opcional de
 * fato. Import estático quebraria o bundle em qualquer build sem o módulo.
 */
function loadNativeScrypt(): NativeScryptSync | null {
  if (!isNativeScryptEnabled()) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const quickCrypto = require('react-native-quick-crypto');
    const candidate = quickCrypto?.scryptSync || quickCrypto?.default?.scryptSync;
    return typeof candidate === 'function' ? (candidate as NativeScryptSync) : null;
  } catch {
    return null;
  }
}

function ensureNativeChecked(): void {
  if (nativeState !== 'unchecked') return;

  const candidate = loadNativeScrypt();
  if (!candidate) {
    nativeState = 'unavailable';
    return;
  }

  try {
    const password = new TextEncoder().encode(RFC7914_VECTOR.password);
    const salt = new TextEncoder().encode(RFC7914_VECTOR.salt);

    const fromNative = callNative(candidate, password, salt, {
      N: RFC7914_VECTOR.N,
      r: RFC7914_VECTOR.r,
      p: RFC7914_VECTOR.p,
      dkLen: RFC7914_VECTOR.dkLen,
    });
    const fromNoble = nobleScrypt(password, salt, {
      N: RFC7914_VECTOR.N,
      r: RFC7914_VECTOR.r,
      p: RFC7914_VECTOR.p,
      dkLen: RFC7914_VECTOR.dkLen,
    });

    if (bytesEqual(fromNative, fromNoble)) {
      nativeScrypt = candidate;
      nativeState = 'verified';
    } else {
      // Divergiu: não é a mesma função. Nunca usar.
      console.warn('[scrypt] Implementação nativa divergiu do vetor de teste — mantendo JS.');
      nativeState = 'unavailable';
    }
  } catch (error: any) {
    console.warn('[scrypt] Verificação da implementação nativa falhou — mantendo JS:', error?.message || error);
    nativeState = 'unavailable';
  }
}

/** Para telemetria/diagnóstico: qual caminho está em uso. */
export function getScryptBackend(): 'native' | 'js' {
  ensureNativeChecked();
  return nativeState === 'verified' ? 'native' : 'js';
}

/**
 * Derivação que não bloqueia a UI.
 *
 * No caminho nativo o cálculo acontece fora da thread JS, então nem precisa
 * fatiar. No caminho JS cai no `scryptAsync` com `asyncTick`, que depende do
 * `patches/@noble+hashes+1.8.0.patch` — sem o patch o `nextTick` do noble é
 * microtask e NÃO devolve a thread. Ver project-scrypt-ui-freeze.
 */
export async function deriveScryptKeyAsync(
  password: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams
): Promise<Uint8Array> {
  ensureNativeChecked();

  if (nativeState === 'verified' && nativeScrypt) {
    try {
      return callNative(nativeScrypt, password, salt, params);
    } catch (error: any) {
      // Falhou em uso real depois de ter passado na verificação: desliga e
      // reprocessa em JS. Melhor lento que sem abrir a carteira.
      console.warn('[scrypt] Falha no nativo em execução — caindo para JS:', error?.message || error);
      nativeState = 'unavailable';
      nativeScrypt = null;
    }
  }

  return nobleScryptAsync(password, salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: params.dkLen,
    asyncTick: 50,
  });
}

/**
 * Versão síncrona, só para os caminhos de ESCRITA que ainda são síncronos
 * (`encryptStringToEnvelope`). Com o nativo verificado ela deixa de bloquear
 * de forma perceptível; sem ele, é o mesmo scrypt de sempre.
 */
export function deriveScryptKeySync(
  password: Uint8Array,
  salt: Uint8Array,
  params: ScryptParams
): Uint8Array {
  ensureNativeChecked();

  if (nativeState === 'verified' && nativeScrypt) {
    try {
      return callNative(nativeScrypt, password, salt, params);
    } catch (error: any) {
      console.warn('[scrypt] Falha no nativo em execução — caindo para JS:', error?.message || error);
      nativeState = 'unavailable';
      nativeScrypt = null;
    }
  }

  return nobleScrypt(password, salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: params.dkLen,
  });
}
