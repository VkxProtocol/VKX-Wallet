// src/services/networks/starknet.ts
// Núcleo da rede Starknet (PoC para o Starknet Foundation Seed Grant, 20/11/2026):
// derivação de conta, endereço, validação, saldo ETH/STRK, estado de implantação,
// estimativa de taxa, implantação da conta, envio assinado LOCALMENTE e
// confirmação. Arquivo PURO (sem React Native) para rodar com tsx nos testes e
// nos scripts de evidência. Nenhuma tela usa este módulo ainda (Fase 2).
//
// Decisões:
// - SDK oficial starknet.js 10.8.0 (versão exata). starkzap-native 4.0.1 foi
//   descartado: depende de expo ^55 e o app está no Expo 54.
// - A Starknet NÃO usa o endereço EVM. A conta é um contrato: endereço =
//   hash(classe da conta, chave pública Stark, sal). Nada aqui reaproveita
//   endereço ou assinatura EVM.
// - Derivação: frase BIP39 -> BIP32 secp256k1 em m/44'/9004'/0'/0/{índice}
//   (coin type 9004 = Starknet na SLIP-44) -> "grind" da StarkWare para cair na
//   ordem da curva Stark. É o mesmo esquema do starknet.js/@scure (grindKey) e
//   foi conferido com duas referências independentes (Python e Rust); ver
//   README.md.
// - Conta: OpenZeppelin AccountUpgradeable (cairo-contracts 4.x), classe
//   0x03013bf2…6144 publicada pela OpenZeppelin e declarada na Sepolia;
//   construtor recebe só a chave pública. Sal = chave pública.
// - Conta nova existe só "no papel" até o 1º DEPLOY_ACCOUNT. Ela já pode
//   RECEBER tokens nesse endereço; para ENVIAR precisa estar implantada
//   (custa uma taxa em STRK, paga pela própria conta).
// - Taxas: transações V3, pagas em STRK (unidade "fri", 18 casas). Enviar ETH
//   também exige STRK para a taxa.
// - PoC só na Sepolia. Não há RPC de mainnet configurado de propósito: qualquer
//   tentativa na mainnet falha antes de assinar.

import { HDNodeWallet, formatUnits, parseUnits } from 'ethers';
import {
  Account,
  RpcProvider,
  ec,
  hash,
  logger,
  num,
  validateAndParseAddress,
  validateChecksumAddress,
  type Call,
  type EstimateFeeResponseOverhead,
} from 'starknet';

export type StarknetNetworkName = 'sepolia' | 'mainnet';
export type StarknetTokenSymbol = 'ETH' | 'STRK';

/** Caminho BIP44 da Starknet (coin type 9004). Índice = índice HD da conta VKX. */
export const STARKNET_DERIVATION_PATH_BASE = "m/44'/9004'/0'/0";

/**
 * LEGADO — OpenZeppelin AccountUpgradeable 4.x (Scarb 2.18.0, --release). Só
 * declarada na Sepolia. Usada pelas contas de teste da PoC (Fases 1–2); fica
 * apenas para RECUPERAR essas contas. Contas novas usam a 3.x.
 */
export const OZ_ACCOUNT_CLASS_HASH_V4_LEGACY =
  '0x03013bf2edcf93ac575367eee41cd07bb50e809c78925817b61878db29826144';
/**
 * OpenZeppelin AccountUpgradeable, cairo-contracts 3.x (Scarb 2.13.1, --release).
 * Declarada na mainnet E na Sepolia (conferido 20/11/2026: hash recalculado do
 * código baixado do nó, construtor (public_key)). A 4.x NÃO existe na mainnet.
 */
export const OZ_ACCOUNT_CLASS_HASH_V3 =
  '0x01d1777db36cdd06dd62cfde77b1b6ae06412af95d57a13dc40ac77b8a702381';

/**
 * Liberação da mainnet. Muda SÓ editando este literal numa revisão aprovada pelo
 * dono. Nenhuma variável de ambiente, flag remota ou tela altera este valor.
 * Enquanto for false, a mainnet não tem RPC: leitura, assinatura e envio falham
 * com NETWORK_DISABLED antes de qualquer requisição.
 */
export const STARKNET_MAINNET_RELEASE_APPROVED: boolean = false;

/** Configuração CANDIDATA da mainnet (Fase 3). Só usada se a constante acima virar true. */
export const STARKNET_MAINNET_CANDIDATE = Object.freeze({
  chainId: '0x534e5f4d41494e', // "SN_MAIN"
  // Conferidos 20/11/2026 (scripts/starknet-mainnet-readiness.ts): SN_MAIN,
  // tokens oficiais e classe OZ 3.x. O drpc público foi REPROVADO (não tem
  // starknet_blockNumber). Antes de liberar: somar um 3º RPC (provedor pago).
  rpcUrls: Object.freeze([
    'https://api.zan.top/public/starknet-mainnet/rpc/v0_9',
    'https://starknet-rpc.publicnode.com',
  ]),
  explorerUrl: 'https://voyager.online',
  accountClassHash: OZ_ACCOUNT_CLASS_HASH_V3,
});

/**
 * Classe PADRÃO (decisão do dono, opção C, 20/11/2026): OZ 3.x nas DUAS redes,
 * então a mesma frase/índice gera o MESMO endereço na Sepolia e na mainnet.
 */
export const STARKNET_ACCOUNT_CLASS_HASH = OZ_ACCOUNT_CLASS_HASH_V3;

/** Classes antigas aceitas só para reconhecer/recuperar contas já existentes. */
export const STARKNET_LEGACY_ACCOUNT_CLASS_HASHES: readonly string[] = Object.freeze([OZ_ACCOUNT_CLASS_HASH_V4_LEGACY]);

/** Classe da conta usada para CALCULAR o endereço em cada rede. */
const ACCOUNT_CLASS_BY_NETWORK: Record<'sepolia' | 'mainnet', string> = {
  sepolia: STARKNET_ACCOUNT_CLASS_HASH,
  mainnet: STARKNET_MAINNET_CANDIDATE.accountClassHash,
};

export function starknetAccountClassHash(network: 'sepolia' | 'mainnet' = 'sepolia'): string {
  return ACCOUNT_CLASS_BY_NETWORK[network];
}

/** Ordem da curva Stark: chave privada válida está em [1, N-1]. */
export const STARK_CURVE_ORDER = 0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2fn;
/** Endereços Starknet são < 2^251. */
const ADDRESS_UPPER_BOUND = 2n ** 251n;

export const STARKNET_TOKENS: Record<StarknetTokenSymbol, { address: string; decimals: number; name: string }> = {
  // Mesmos endereços na Sepolia e na mainnet (contratos oficiais da StarkGate).
  ETH: {
    address: '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
    decimals: 18,
    name: 'Ether',
  },
  STRK: {
    address: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    decimals: 18,
    name: 'Starknet Token',
  },
};

const RPC_URLS: Record<StarknetNetworkName, string[]> = {
  // 1º: nó padrão do próprio starknet.js 10.8.0 para SN_SEPOLIA.
  sepolia: [
    'https://api.zan.top/public/starknet-sepolia/rpc/v0_9',
    'https://starknet-sepolia-rpc.publicnode.com',
    'https://starknet-sepolia.drpc.org',
  ],
  // Vazio até a liberação explícita (ver STARKNET_MAINNET_RELEASE_APPROVED).
  mainnet: STARKNET_MAINNET_RELEASE_APPROVED ? [...STARKNET_MAINNET_CANDIDATE.rpcUrls] : [],
};

const CHAIN_IDS: Record<StarknetNetworkName, string> = {
  sepolia: '0x534e5f5345504f4c4941', // "SN_SEPOLIA"
  mainnet: '0x534e5f4d41494e', // "SN_MAIN"
};

const EXPLORER_URLS: Record<StarknetNetworkName, string> = {
  sepolia: 'https://sepolia.voyager.online',
  mainnet: STARKNET_MAINNET_CANDIDATE.explorerUrl,
};

const DEFAULT_TIMEOUT_MS = 20_000;

// O starknet.js avisa no console quando há poucos blocos para calcular a gorjeta;
// é informativo e polui o log do app.
logger.setLogLevel('ERROR');

export type StarknetErrorCode =
  | 'INVALID_MNEMONIC'
  | 'INVALID_PRIVATE_KEY'
  | 'INVALID_ADDRESS'
  | 'EVM_ADDRESS'
  | 'SELF_TRANSFER'
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_FEE_BALANCE'
  | 'ACCOUNT_NOT_DEPLOYED'
  | 'NETWORK_DISABLED'
  | 'RPC_UNAVAILABLE'
  | 'TX_REVERTED'
  | 'TX_REJECTED'
  | 'TX_TIMEOUT'
  | 'BROADCAST_FAILED';

export class StarknetError extends Error {
  readonly code: StarknetErrorCode;
  constructor(code: StarknetErrorCode, message: string) {
    super(message);
    this.name = 'StarknetError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Rede

export function normalizeStarknetNetworkName(value?: string | null): StarknetNetworkName {
  return String(value || '').trim().toLowerCase() === 'mainnet' ? 'mainnet' : 'sepolia';
}

export function getStarknetNetworkName(): StarknetNetworkName {
  return normalizeStarknetNetworkName(process.env.EXPO_PUBLIC_STARKNET_NETWORK);
}

export function getStarknetRpcUrls(network: StarknetNetworkName = getStarknetNetworkName()): string[] {
  return [...RPC_URLS[network]];
}

export function getStarknetChainId(network: StarknetNetworkName = getStarknetNetworkName()): string {
  return CHAIN_IDS[network];
}

function timeoutFetch(timeoutMs: number) {
  return async (input: any, init?: any) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...(init || {}), signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createStarknetProvider(nodeUrl: string, network: StarknetNetworkName): RpcProvider {
  return new RpcProvider({
    nodeUrl,
    chainId: CHAIN_IDS[network] as any,
    baseFetch: timeoutFetch(DEFAULT_TIMEOUT_MS) as any,
  });
}

/** Erro de transporte (nó fora, timeout, 429/5xx) — vale tentar o próximo RPC. */
export function isStarknetTransportError(err: unknown): boolean {
  if (err instanceof StarknetError) return false;
  const msg = String((err as any)?.message || err || '').toLowerCase();
  return /abort|timeout|timed out|fetch failed|network|econn|enotfound|socket|429|too many|50[0-9]|bad gateway|unavailable|failed to fetch/.test(
    msg,
  );
}

/** Executa uma LEITURA no 1º RPC que responder. Não usar para broadcast. */
export async function withStarknetRpc<T>(
  fn: (provider: RpcProvider) => Promise<T>,
  network: StarknetNetworkName = getStarknetNetworkName(),
): Promise<T> {
  const urls = RPC_URLS[network];
  if (!urls.length) throw new StarknetError('NETWORK_DISABLED', `Starknet ${network} não está habilitada nesta versão.`);
  let last: unknown;
  for (const url of urls) {
    try {
      return await fn(createStarknetProvider(url, network));
    } catch (err) {
      last = err;
      if (!isStarknetTransportError(err)) throw err;
    }
  }
  throw new StarknetError('RPC_UNAVAILABLE', `Nenhum nó Starknet respondeu (${String((last as any)?.message || last).slice(0, 120)})`);
}

// ---------------------------------------------------------------------------
// Chaves e endereço

export interface StarknetKeyPair {
  /** Chave privada Stark (0x + 64 hex). SEGREDO: nunca logar. */
  privateKey: string;
  /** Chave pública Stark (0x + 64 hex). */
  publicKey: string;
}

export interface StarknetAccountKeys extends StarknetKeyPair {
  address: string;
  classHash: string;
  derivationPath?: string;
}

export function starknetDerivationPath(index: number = 0): string {
  if (!Number.isInteger(index) || index < 0 || index >= 2 ** 31) {
    throw new StarknetError('INVALID_PRIVATE_KEY', 'Índice de conta inválido.');
  }
  return `${STARKNET_DERIVATION_PATH_BASE}/${index}`;
}

function pad64(value: bigint | string): string {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

/** "Grind" da StarkWare: leva 32 bytes quaisquer para uma chave Stark válida. */
export function grindStarkKey(seedHex: string): string {
  return pad64(BigInt(`0x${ec.starkCurve.grindKey(seedHex).replace(/^0x/, '')}`));
}

export function starknetKeyPairFromPrivateKey(privateKey: string): StarknetKeyPair {
  let k: bigint;
  try {
    k = BigInt(privateKey);
  } catch {
    throw new StarknetError('INVALID_PRIVATE_KEY', 'Chave Starknet inválida.');
  }
  if (k <= 0n || k >= STARK_CURVE_ORDER) throw new StarknetError('INVALID_PRIVATE_KEY', 'Chave Starknet fora da curva.');
  const priv = pad64(k);
  return { privateKey: priv, publicKey: pad64(ec.starkCurve.getStarkKey(priv)) };
}

export function deriveStarknetKeyPairFromMnemonic(mnemonic: string, index: number = 0): StarknetKeyPair & { derivationPath: string } {
  const phrase = String(mnemonic || '').trim().split(/\s+/).join(' ');
  const derivationPath = starknetDerivationPath(index);
  let node: HDNodeWallet;
  try {
    node = HDNodeWallet.fromPhrase(phrase, undefined, derivationPath);
  } catch {
    throw new StarknetError('INVALID_MNEMONIC', 'Frase de recuperação inválida.');
  }
  return { ...starknetKeyPairFromPrivateKey(grindStarkKey(node.privateKey)), derivationPath };
}

export function computeStarknetAccountAddress(publicKey: string, classHash: string = STARKNET_ACCOUNT_CLASS_HASH): string {
  const pub = pad64(publicKey);
  return pad64(hash.calculateContractAddressFromHash(pub, classHash, [pub], 0));
}

export function deriveStarknetAccountFromMnemonic(
  mnemonic: string,
  index: number = 0,
  classHash: string = STARKNET_ACCOUNT_CLASS_HASH,
): StarknetAccountKeys {
  const kp = deriveStarknetKeyPairFromMnemonic(mnemonic, index);
  return { ...kp, address: computeStarknetAccountAddress(kp.publicKey, classHash), classHash: pad64(classHash) };
}

export function starknetAccountFromPrivateKey(privateKey: string, classHash: string = STARKNET_ACCOUNT_CLASS_HASH): StarknetAccountKeys {
  const kp = starknetKeyPairFromPrivateKey(privateKey);
  return { ...kp, address: computeStarknetAccountAddress(kp.publicKey, classHash), classHash: pad64(classHash) };
}

// Chave fixa e PÚBLICA, só para estimar taxa antes do PIN: a estimativa da
// Starknet não valida a assinatura, então basta endereço + chave pública reais.
// Nunca assina nada que vá para a rede (assertSigningKeys barra).
const ESTIMATE_ONLY_PRIVATE_KEY = `0x${'0'.repeat(63)}1`;

/** Chaves só para estimar taxa (sem segredo). Confere que a chave pública gera o endereço. */
export function starknetEstimationKeys(address: string, publicKey: string): StarknetAccountKeys {
  const addr = normalizeStarknetAddress(address);
  const pub = pad64(publicKey);
  const classHash = [STARKNET_ACCOUNT_CLASS_HASH, ...STARKNET_LEGACY_ACCOUNT_CLASS_HASHES]
    .find((c) => computeStarknetAccountAddress(pub, c) === addr);
  if (!classHash) {
    throw new StarknetError('INVALID_ADDRESS', 'A chave pública não corresponde a este endereço Starknet.');
  }
  return { privateKey: ESTIMATE_ONLY_PRIVATE_KEY, publicKey: pub, address: addr, classHash: pad64(classHash) };
}

/** Antes de transmitir: a chave privada tem de gerar a chave pública e o endereço da conta. */
function assertSigningKeys(keys: StarknetAccountKeys): void {
  const kp = starknetKeyPairFromPrivateKey(keys.privateKey);
  if (kp.privateKey === pad64(ESTIMATE_ONLY_PRIVATE_KEY) || kp.publicKey !== pad64(keys.publicKey)
    || computeStarknetAccountAddress(kp.publicKey, keys.classHash) !== pad64(keys.address)) {
    throw new StarknetError('INVALID_PRIVATE_KEY', 'A chave não corresponde a esta conta Starknet.');
  }
}

/** Conta padrão (3.x) e variantes legadas da MESMA chave, nesta ordem. */
export function starknetAccountCandidatesFromMnemonic(
  mnemonic: string,
  index: number = 0,
): Array<StarknetAccountKeys & { legacy: boolean }> {
  return [STARKNET_ACCOUNT_CLASS_HASH, ...STARKNET_LEGACY_ACCOUNT_CLASS_HASHES].map((c, i) => ({
    ...deriveStarknetAccountFromMnemonic(mnemonic, index, c),
    legacy: i > 0,
  }));
}

/** Escolhe o candidato que gera exatamente o endereço informado (ou null). */
export function selectStarknetAccountForAddress<T extends StarknetAccountKeys>(candidates: T[], address?: string | null): T | null {
  if (!address) return null;
  let wanted: bigint;
  try {
    wanted = BigInt(String(address).trim());
  } catch {
    return null;
  }
  return candidates.find((c) => BigInt(c.address) === wanted) || null;
}

/**
 * Descoberta SÓ DE LEITURA: usa a conta padrão (3.x), a não ser que ela esteja
 * vazia (não implantada e sem saldo) e uma variante legada tenha atividade
 * (implantada ou com saldo) — assim contas antigas não "somem". Falha de rede
 * mantém a padrão (nunca escolhe legado sem prova).
 */
export async function discoverStarknetAccount<T extends StarknetAccountKeys & { legacy: boolean }>(
  candidates: T[],
  network: StarknetNetworkName = getStarknetNetworkName(),
): Promise<T> {
  const [primary, ...legacy] = candidates;
  const hasActivity = async (a: StarknetAccountKeys): Promise<boolean> => {
    const [state, bal] = await Promise.all([getStarknetAccountState(a.address, network), getStarknetBalances(a.address, network)]);
    return state.deployed || bal.STRK > 0n || bal.ETH > 0n;
  };
  try {
    if (await hasActivity(primary)) return primary;
    for (const l of legacy) if (await hasActivity(l)) return l;
  } catch {
    // sem rede: fica com a padrão
  }
  return primary;
}

/** Só o que pode aparecer em tela/log: endereço e chave pública. */
export function publicStarknetAccount(acc: StarknetAccountKeys) {
  return { address: acc.address, publicKey: acc.publicKey, classHash: acc.classHash, derivationPath: acc.derivationPath };
}

// ---------------------------------------------------------------------------
// Validação de endereço

export type StarknetAddressCheck =
  | { ok: true; address: string }
  | { ok: false; code: 'INVALID_ADDRESS' | 'EVM_ADDRESS'; message: string };

export function checkStarknetAddress(input: string): StarknetAddressCheck {
  const raw = String(input || '').trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(raw)) {
    return { ok: false, code: 'INVALID_ADDRESS', message: 'Endereço Starknet inválido. Ele começa com 0x e tem até 64 caracteres.' };
  }
  // 0x + 40 hex é endereço EVM: na Starknet seria outra conta (fundos perdidos).
  if (/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    return { ok: false, code: 'EVM_ADDRESS', message: 'Este é um endereço de rede EVM, não da Starknet.' };
  }
  const value = BigInt(raw);
  if (value === 0n || value >= ADDRESS_UPPER_BOUND) {
    return { ok: false, code: 'INVALID_ADDRESS', message: 'Endereço Starknet fora do intervalo válido.' };
  }
  const hex = raw.slice(2);
  const mixedCase = hex !== hex.toLowerCase() && hex !== hex.toUpperCase();
  if (mixedCase && !validateChecksumAddress(raw)) {
    return { ok: false, code: 'INVALID_ADDRESS', message: 'Endereço Starknet com dígito verificador errado. Copie de novo.' };
  }
  return { ok: true, address: pad64(validateAndParseAddress(raw)) };
}

export function isValidStarknetAddress(input: string): boolean {
  return checkStarknetAddress(input).ok;
}

export function normalizeStarknetAddress(input: string): string {
  const r = checkStarknetAddress(input);
  if (!r.ok) throw new StarknetError(r.code, r.message);
  return r.address;
}

export function getStarknetExplorerTxUrl(txHash: string, network: StarknetNetworkName = getStarknetNetworkName()): string {
  return `${EXPLORER_URLS[network]}/tx/${pad64(txHash)}`;
}

export function getStarknetExplorerAddressUrl(address: string, network: StarknetNetworkName = getStarknetNetworkName()): string {
  return `${EXPLORER_URLS[network]}/contract/${pad64(address)}`;
}

// ---------------------------------------------------------------------------
// Valores

export function parseStarknetAmount(amount: string | number, decimals: number = 18): bigint {
  const text = String(amount ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) throw new StarknetError('INVALID_AMOUNT', 'Valor inválido.');
  let raw: bigint;
  try {
    raw = parseUnits(text, decimals);
  } catch {
    throw new StarknetError('INVALID_AMOUNT', `Valor com mais de ${decimals} casas decimais.`);
  }
  if (raw <= 0n) throw new StarknetError('INVALID_AMOUNT', 'O valor precisa ser maior que zero.');
  return raw;
}

export function formatStarknetAmount(raw: bigint | string | number, decimals: number = 18): string {
  const s = formatUnits(BigInt(raw), decimals);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// ---------------------------------------------------------------------------
// Leitura on-chain

export async function getStarknetTokenBalance(
  address: string,
  token: StarknetTokenSymbol,
  network: StarknetNetworkName = getStarknetNetworkName(),
): Promise<bigint> {
  const owner = normalizeStarknetAddress(address);
  const res = await withStarknetRpc(
    (p) => p.callContract({ contractAddress: STARKNET_TOKENS[token].address, entrypoint: 'balance_of', calldata: [owner] }, 'latest'),
    network,
  );
  // u256 = [low, high]
  return BigInt(res[0] ?? 0) + (BigInt(res[1] ?? 0) << 128n);
}

export async function getStarknetBalances(
  address: string,
  network: StarknetNetworkName = getStarknetNetworkName(),
): Promise<Record<StarknetTokenSymbol, bigint>> {
  const [eth, strk] = await Promise.all([
    getStarknetTokenBalance(address, 'ETH', network),
    getStarknetTokenBalance(address, 'STRK', network),
  ]);
  return { ETH: eth, STRK: strk };
}

function isContractNotFound(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return /contract not found|CONTRACT_NOT_FOUND|"code":\s*20\b|\b20\b: Contract not found/i.test(msg);
}

export async function getStarknetAccountState(
  address: string,
  network: StarknetNetworkName = getStarknetNetworkName(),
): Promise<{ deployed: boolean; classHash: string | null }> {
  const addr = normalizeStarknetAddress(address);
  return withStarknetRpc(async (p) => {
    try {
      const classHash = await p.getClassHashAt(addr, 'latest');
      return { deployed: true, classHash: pad64(classHash) };
    } catch (err) {
      if (isContractNotFound(err)) return { deployed: false, classHash: null };
      throw err;
    }
  }, network);
}

// ---------------------------------------------------------------------------
// Taxas, implantação e envio

/** Teto que a rede reserva do saldo de STRK: soma de max_amount × max_price. */
export function maxFeeFromEstimate(est: Pick<EstimateFeeResponseOverhead, 'resourceBounds' | 'overall_fee'>): bigint {
  const rb: any = est.resourceBounds || {};
  let total = 0n;
  for (const k of ['l1_gas', 'l2_gas', 'l1_data_gas']) {
    if (rb[k]) total += BigInt(rb[k].max_amount ?? 0) * BigInt(rb[k].max_price_per_unit ?? 0);
  }
  return total > 0n ? total : BigInt(est.overall_fee);
}

export interface StarknetFeeQuote {
  /** Taxa estimada (STRK, em fri), já com a margem de segurança do starknet.js. */
  estimatedFee: bigint;
  /** Teto autorizado na assinatura (STRK, em fri); precisa haver saldo. */
  maxFee: bigint;
  /** Inclui a implantação da conta (1ª transação). */
  includesDeploy: boolean;
}

function accountFor(keys: StarknetAccountKeys, provider: RpcProvider): Account {
  // cairoVersion fixo: sem isso o starknet.js baixa a classe inteira da conta
  // (centenas de KB) só para descobrir a versão. A conta OZ é Cairo 1.
  return new Account({ provider, address: keys.address, signer: keys.privateKey, cairoVersion: '1' });
}

function deployPayload(keys: StarknetAccountKeys) {
  return {
    classHash: keys.classHash,
    constructorCalldata: [keys.publicKey],
    addressSalt: keys.publicKey,
    contractAddress: keys.address,
  };
}

export function buildStarknetTransferCall(token: StarknetTokenSymbol, to: string, amount: bigint): Call {
  const recipient = normalizeStarknetAddress(to);
  const low = amount & ((1n << 128n) - 1n);
  const high = amount >> 128n;
  return {
    contractAddress: STARKNET_TOKENS[token].address,
    entrypoint: 'transfer',
    calldata: [recipient, num.toHex(low), num.toHex(high)],
  };
}

export async function estimateStarknetDeployFee(
  keys: StarknetAccountKeys,
  network: StarknetNetworkName = getStarknetNetworkName(),
): Promise<StarknetFeeQuote> {
  const est = await withStarknetRpc((p) => accountFor(keys, p).estimateAccountDeployFee(deployPayload(keys)), network);
  return { estimatedFee: BigInt(est.overall_fee), maxFee: maxFeeFromEstimate(est), includesDeploy: true };
}

/** Simulação que reverteu por saldo vira erro claro em vez do texto bruto do nó. */
function mapEstimateError(err: unknown): never {
  const msg = String((err as any)?.message || err || '');
  if (/insufficient balance|u256_sub Overflow/i.test(msg)) {
    throw new StarknetError('INSUFFICIENT_BALANCE', 'Saldo insuficiente para este envio.');
  }
  throw err;
}

export async function estimateStarknetTransferFee(
  params: { keys: StarknetAccountKeys; token: StarknetTokenSymbol; to: string; amount: bigint },
  network: StarknetNetworkName = getStarknetNetworkName(),
): Promise<StarknetFeeQuote> {
  return estimateTransferFeeRaw(params, network).catch(mapEstimateError);
}

async function estimateTransferFeeRaw(
  params: { keys: StarknetAccountKeys; token: StarknetTokenSymbol; to: string; amount: bigint },
  network: StarknetNetworkName,
): Promise<StarknetFeeQuote> {
  const { keys } = params;
  const call = buildStarknetTransferCall(params.token, params.to, params.amount);
  const { deployed } = await getStarknetAccountState(keys.address, network);
  if (deployed) {
    const est = await withStarknetRpc((p) => accountFor(keys, p).estimateInvokeFee(call), network);
    return { estimatedFee: BigInt(est.overall_fee), maxFee: maxFeeFromEstimate(est), includesDeploy: false };
  }
  // Conta ainda não implantada: estima implantação + transferência juntas.
  const ests = await withStarknetRpc(
    (p) =>
      accountFor(keys, p).estimateFeeBulk([
        { type: 'DEPLOY_ACCOUNT' as any, payload: deployPayload(keys) },
        { type: 'INVOKE' as any, payload: [call] },
      ]),
    network,
  );
  return {
    estimatedFee: ests.reduce((s, e) => s + BigInt(e.overall_fee), 0n),
    maxFee: ests.reduce((s, e) => s + maxFeeFromEstimate(e), 0n),
    includesDeploy: true,
  };
}

/**
 * pending   = recebida/aceita no mempool, ainda sem resultado final;
 * confirmed = ACCEPTED_ON_L2/L1 com execution_status SUCCEEDED explícito;
 * reverted  = executada e revertida (taxa cobrada, valor não saiu);
 * rejected  = recusada pela rede (não entrou em bloco);
 * timeout   = o prazo de espera acabou SEM resultado — NÃO é falha: a
 *             transação pode entrar depois. Nunca reenviar automaticamente.
 */
export type StarknetTxStatus = 'pending' | 'confirmed' | 'reverted' | 'rejected' | 'timeout';

/** Classifica o status bruto do nó. Ausência de execution_status nunca vira sucesso. */
export function classifyStarknetTxStatus(
  raw: { finality_status?: string | null; execution_status?: string | null } | null | undefined,
): Exclude<StarknetTxStatus, 'timeout'> {
  const fin = String(raw?.finality_status || '').toUpperCase();
  const exec = String(raw?.execution_status || '').toUpperCase();
  if (fin === 'REJECTED') return 'rejected';
  if (exec === 'REVERTED') return 'reverted';
  if ((fin === 'ACCEPTED_ON_L2' || fin === 'ACCEPTED_ON_L1') && exec === 'SUCCEEDED') return 'confirmed';
  return 'pending';
}

export type StarknetTxOutcome = {
  txHash: string;
  status: StarknetTxStatus;
  finality: string | null;
  blockNumber: number | null;
  actualFee: bigint | null;
  revertReason?: string;
};

function isTxNotFound(err: unknown): boolean {
  return /transaction hash not found|TXN_HASH_NOT_FOUND|"code":\s*29\b|\b29\b: Transaction hash not found/i.test(
    String((err as any)?.message || err || ''),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Espera o resultado da transação consultando o status (leitura com troca de
 * nó). Só devolve 'confirmed' com finalidade aceita E execução SUCCEEDED.
 * Prazo esgotado devolve 'timeout' (não lança): a transação pode entrar depois.
 */
export async function waitForStarknetTransaction(
  txHash: string,
  network: StarknetNetworkName = getStarknetNetworkName(),
  opts: { timeoutMs?: number; retryIntervalMs?: number } = {},
): Promise<StarknetTxOutcome> {
  const hash = pad64(txHash);
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  const interval = opts.retryIntervalMs ?? 3_000;
  let last: { finality_status?: string; execution_status?: string } | null = null;
  for (;;) {
    try {
      last = (await withStarknetRpc((p) => p.getTransactionStatus(hash) as any, network)) as any;
    } catch (err) {
      // Ainda não visto pelo nó (ou nó fora): continua pendente até o prazo.
      if (!isTxNotFound(err) && !(err instanceof StarknetError && err.code === 'RPC_UNAVAILABLE')) throw err;
      last = null;
    }
    const status = classifyStarknetTxStatus(last);
    if (status === 'rejected') {
      return { txHash: hash, status, finality: last?.finality_status ?? null, blockNumber: null, actualFee: null };
    }
    if (status === 'confirmed' || status === 'reverted') {
      let receipt: any = null;
      try {
        receipt = await withStarknetRpc((p) => p.getTransactionReceipt(hash) as any, network);
      } catch {
        receipt = null; // o status já é final; recibo é só detalhe (bloco/taxa)
      }
      const value = receipt?.value ?? receipt;
      const fee = value?.actual_fee?.amount;
      return {
        txHash: hash,
        status,
        finality: last?.finality_status ?? null,
        blockNumber: typeof value?.block_number === 'number' ? value.block_number : null,
        actualFee: fee != null ? BigInt(fee) : null,
        ...(status === 'reverted' ? { revertReason: String(value?.revert_reason || '').slice(0, 300) } : {}),
      };
    }
    if (Date.now() + interval > deadline) {
      return { txHash: hash, status: 'timeout', finality: last?.finality_status ?? null, blockNumber: null, actualFee: null };
    }
    await sleep(interval);
  }
}

/** Transmite e traduz falha de transporte; nunca tenta outro nó (evita duplicar). */
async function broadcast<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isStarknetTransportError(err)) {
      throw new StarknetError(
        'BROADCAST_FAILED',
        'Não foi possível enviar à rede agora. Confira o histórico antes de tentar de novo.',
      );
    }
    throw err;
  }
}

// Envios do mesmo remetente em fila: dois envios simultâneos pegariam o mesmo nonce.
const sendQueues = new Map<string, Promise<unknown>>();
function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = sendQueues.get(key) || Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  sendQueues.set(key, next.catch(() => undefined));
  return next;
}

/** Broadcast usa SÓ o 1º RPC: reenviar em outro nó poderia duplicar a transação. */
function broadcastProvider(network: StarknetNetworkName): RpcProvider {
  const url = RPC_URLS[network][0];
  if (!url) throw new StarknetError('NETWORK_DISABLED', `Starknet ${network} não está habilitada nesta versão.`);
  return createStarknetProvider(url, network);
}

export async function deployStarknetAccount(
  keys: StarknetAccountKeys,
  network: StarknetNetworkName = getStarknetNetworkName(),
  opts: { wait?: boolean; waitOptions?: { timeoutMs?: number; retryIntervalMs?: number } } = {},
): Promise<StarknetTxOutcome & { alreadyDeployed?: boolean }> {
  assertSigningKeys(keys);
  return serialized(keys.address, async () => {
    const state = await getStarknetAccountState(keys.address, network);
    if (state.deployed) {
      // Sem transação: o estado veio da própria rede (classe na conta).
      return { txHash: '', status: 'confirmed', finality: null, blockNumber: null, actualFee: null, alreadyDeployed: true };
    }
    const quote = await estimateStarknetDeployFee(keys, network);
    const strk = await getStarknetTokenBalance(keys.address, 'STRK', network);
    if (strk < quote.maxFee) {
      throw new StarknetError(
        'INSUFFICIENT_FEE_BALANCE',
        `Para ativar a conta é preciso ter ao menos ${formatStarknetAmount(quote.maxFee)} STRK neste endereço.`,
      );
    }
    const res = await broadcast(() => accountFor(keys, broadcastProvider(network)).deployAccount(deployPayload(keys)));
    const txHash = pad64(res.transaction_hash);
    if (opts.wait === false) return { txHash, status: 'pending', finality: 'RECEIVED', blockNumber: null, actualFee: null };
    const out = await waitForStarknetTransaction(txHash, network, opts.waitOptions);
    if (out.status === 'reverted') throw new StarknetError('TX_REVERTED', 'A ativação da conta foi revertida pela rede.');
    if (out.status === 'rejected') throw new StarknetError('TX_REJECTED', 'A rede rejeitou a ativação da conta.');
    if (out.status !== 'confirmed') {
      // Sem resultado ainda: não segue para a transferência (ela falharia).
      throw new StarknetError('TX_TIMEOUT', `A ativação foi enviada (${txHash}) e ainda não confirmou. Tente de novo em alguns minutos.`);
    }
    return out;
  });
}

export interface SendStarknetTokenParams {
  keys: StarknetAccountKeys;
  token: StarknetTokenSymbol;
  to: string;
  /** Valor em unidades mínimas (18 casas). */
  amount: bigint;
  /** Implanta a conta antes, se ainda não estiver implantada. Padrão: true. */
  autoDeploy?: boolean;
  /** Espera a confirmação. Padrão: true. */
  wait?: boolean;
  /** Prazo/intervalo da espera (padrão 180 s / 3 s). */
  waitOptions?: { timeoutMs?: number; retryIntervalMs?: number };
}

export interface SendStarknetTokenResult extends StarknetTxOutcome {
  deployTxHash?: string;
  explorerUrl: string;
}

export async function sendStarknetToken(
  params: SendStarknetTokenParams,
  network: StarknetNetworkName = getStarknetNetworkName(),
): Promise<SendStarknetTokenResult> {
  const { keys, token, amount } = params;
  if (typeof amount !== 'bigint' || amount <= 0n) throw new StarknetError('INVALID_AMOUNT', 'O valor precisa ser maior que zero.');
  const to = normalizeStarknetAddress(params.to);
  assertSigningKeys(keys);
  if (to === pad64(keys.address)) throw new StarknetError('SELF_TRANSFER', 'O destino é o seu próprio endereço Starknet.');

  // Saldo e taxa checados ANTES de qualquer assinatura.
  const balances = await getStarknetBalances(keys.address, network);
  if (balances[token] < amount) {
    throw new StarknetError('INSUFFICIENT_BALANCE', `Saldo de ${token} insuficiente.`);
  }
  const quote = await estimateStarknetTransferFee({ keys, token, to, amount }, network);
  if (quote.includesDeploy && params.autoDeploy === false) {
    throw new StarknetError('ACCOUNT_NOT_DEPLOYED', 'Ative a conta Starknet antes do primeiro envio.');
  }
  // A taxa sai sempre em STRK; enviando STRK, valor + taxa saem do mesmo saldo.
  const strkNeeded = quote.maxFee + (token === 'STRK' ? amount : 0n);
  if (balances.STRK < strkNeeded) {
    throw new StarknetError(
      'INSUFFICIENT_FEE_BALANCE',
      `Falta STRK para a taxa da rede (até ${formatStarknetAmount(quote.maxFee)} STRK).`,
    );
  }

  let deployTxHash: string | undefined;
  if (quote.includesDeploy) {
    const dep = await deployStarknetAccount(keys, network, { wait: true, waitOptions: params.waitOptions });
    deployTxHash = dep.txHash || undefined;
  }

  return serialized(keys.address, async () => {
    const call = buildStarknetTransferCall(token, to, amount);
    const res = await broadcast(() => accountFor(keys, broadcastProvider(network)).execute(call));
    const txHash = pad64(res.transaction_hash);
    const explorerUrl = getStarknetExplorerTxUrl(txHash, network);
    if (params.wait === false) {
      return { txHash, status: 'pending', finality: 'RECEIVED', blockNumber: null, actualFee: null, deployTxHash, explorerUrl };
    }
    const out = await waitForStarknetTransaction(txHash, network, params.waitOptions);
    if (out.status === 'reverted') {
      throw new StarknetError('TX_REVERTED', `A rede recusou a transferência (${txHash}).`);
    }
    if (out.status === 'rejected') throw new StarknetError('TX_REJECTED', 'A rede rejeitou a transação.');
    // confirmed, ou timeout (enviada, resultado ainda não visto): devolve o
    // hash com o estado real; quem chama NUNCA deve reenviar por timeout.
    return { ...out, deployTxHash, explorerUrl };
  });
}

// ---------------------------------------------------------------------------
// Assinatura avulsa (usada nos testes de assinatura local)

export function signStarknetHash(privateKey: string, msgHash: string): { r: string; s: string } {
  const sig = ec.starkCurve.sign(pad64(msgHash), pad64(privateKey));
  return { r: pad64(sig.r), s: pad64(sig.s) };
}

/** Verifica com a chave Stark (só a coordenada x), como o Cairo: aceita os dois pontos com esse x. */
export function verifyStarknetHash(publicKey: string, msgHash: string, sig: { r: string; s: string }): boolean {
  const s = new ec.starkCurve.Signature(BigInt(sig.r), BigInt(sig.s));
  const x = pad64(publicKey).slice(2);
  return ['02', '03'].some((prefix) => {
    try {
      return ec.starkCurve.verify(s, pad64(msgHash), prefix + x);
    } catch {
      return false;
    }
  });
}

/** Só para testes: zera a fila de envios. */
export function __resetStarknetSendQueue(): void {
  sendQueues.clear();
}
