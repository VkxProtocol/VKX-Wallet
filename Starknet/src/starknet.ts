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

/** OpenZeppelin AccountUpgradeable, cairo-contracts 4.x (Scarb 2.18.0, --release). */
export const OZ_ACCOUNT_CLASS_HASH =
  '0x03013bf2edcf93ac575367eee41cd07bb50e809c78925817b61878db29826144';

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
  mainnet: [],
};

const CHAIN_IDS: Record<StarknetNetworkName, string> = {
  sepolia: '0x534e5f5345504f4c4941', // "SN_SEPOLIA"
  mainnet: '0x534e5f4d41494e', // "SN_MAIN"
};

const EXPLORER_URLS: Record<StarknetNetworkName, string> = {
  sepolia: 'https://sepolia.voyager.online',
  mainnet: 'https://voyager.online',
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
  | 'TX_TIMEOUT';

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

export function computeStarknetAccountAddress(publicKey: string, classHash: string = OZ_ACCOUNT_CLASS_HASH): string {
  const pub = pad64(publicKey);
  return pad64(hash.calculateContractAddressFromHash(pub, classHash, [pub], 0));
}

export function deriveStarknetAccountFromMnemonic(mnemonic: string, index: number = 0): StarknetAccountKeys {
  const kp = deriveStarknetKeyPairFromMnemonic(mnemonic, index);
  return { ...kp, address: computeStarknetAccountAddress(kp.publicKey), classHash: OZ_ACCOUNT_CLASS_HASH };
}

export function starknetAccountFromPrivateKey(privateKey: string): StarknetAccountKeys {
  const kp = starknetKeyPairFromPrivateKey(privateKey);
  return { ...kp, address: computeStarknetAccountAddress(kp.publicKey), classHash: OZ_ACCOUNT_CLASS_HASH };
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

export type StarknetTxOutcome = {
  txHash: string;
  status: 'succeeded' | 'reverted' | 'rejected';
  finality: string | null;
  blockNumber: number | null;
  actualFee: bigint | null;
  revertReason?: string;
};

export async function waitForStarknetTransaction(
  txHash: string,
  network: StarknetNetworkName = getStarknetNetworkName(),
  opts: { timeoutMs?: number; retryIntervalMs?: number } = {},
): Promise<StarknetTxOutcome> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const provider = createStarknetProvider(RPC_URLS[network][0], network);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new StarknetError('TX_TIMEOUT', 'A rede ainda não confirmou. Acompanhe pelo explorador.')),
      timeoutMs,
    );
  });
  try {
    const receipt: any = await Promise.race([
      provider.waitForTransaction(txHash, {
        retryInterval: opts.retryIntervalMs ?? 3_000,
        successStates: ['ACCEPTED_ON_L2', 'ACCEPTED_ON_L1'] as any,
      }),
      timeout,
    ]);
    const value = receipt?.value ?? receipt;
    const exec = String(value?.execution_status || '').toUpperCase();
    const fee = value?.actual_fee?.amount;
    return {
      txHash: pad64(txHash),
      status: exec === 'REVERTED' ? 'reverted' : 'succeeded',
      finality: value?.finality_status ?? null,
      blockNumber: typeof value?.block_number === 'number' ? value.block_number : null,
      actualFee: fee != null ? BigInt(fee) : null,
      ...(exec === 'REVERTED' ? { revertReason: String(value?.revert_reason || '').slice(0, 300) } : {}),
    };
  } catch (err) {
    if (err instanceof StarknetError) throw err;
    const msg = String((err as any)?.message || err);
    if (/REJECTED/i.test(msg)) return { txHash: pad64(txHash), status: 'rejected', finality: null, blockNumber: null, actualFee: null };
    if (/REVERTED/i.test(msg)) {
      return { txHash: pad64(txHash), status: 'reverted', finality: null, blockNumber: null, actualFee: null, revertReason: msg.slice(0, 300) };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
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
  opts: { wait?: boolean } = {},
): Promise<StarknetTxOutcome & { alreadyDeployed?: boolean }> {
  return serialized(keys.address, async () => {
    const state = await getStarknetAccountState(keys.address, network);
    if (state.deployed) {
      return { txHash: '', status: 'succeeded', finality: null, blockNumber: null, actualFee: null, alreadyDeployed: true };
    }
    const quote = await estimateStarknetDeployFee(keys, network);
    const strk = await getStarknetTokenBalance(keys.address, 'STRK', network);
    if (strk < quote.maxFee) {
      throw new StarknetError(
        'INSUFFICIENT_FEE_BALANCE',
        `Para ativar a conta é preciso ter ao menos ${formatStarknetAmount(quote.maxFee)} STRK neste endereço.`,
      );
    }
    const res = await accountFor(keys, broadcastProvider(network)).deployAccount(deployPayload(keys));
    const txHash = pad64(res.transaction_hash);
    if (opts.wait === false) return { txHash, status: 'succeeded', finality: 'RECEIVED', blockNumber: null, actualFee: null };
    const out = await waitForStarknetTransaction(txHash, network);
    if (out.status !== 'succeeded') throw new StarknetError(out.status === 'reverted' ? 'TX_REVERTED' : 'TX_REJECTED', 'A ativação da conta falhou na rede.');
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
    const dep = await deployStarknetAccount(keys, network, { wait: true });
    deployTxHash = dep.txHash || undefined;
  }

  return serialized(keys.address, async () => {
    const call = buildStarknetTransferCall(token, to, amount);
    const res = await accountFor(keys, broadcastProvider(network)).execute(call);
    const txHash = pad64(res.transaction_hash);
    const explorerUrl = getStarknetExplorerTxUrl(txHash, network);
    if (params.wait === false) {
      return { txHash, status: 'succeeded', finality: 'RECEIVED', blockNumber: null, actualFee: null, deployTxHash, explorerUrl };
    }
    const out = await waitForStarknetTransaction(txHash, network);
    if (out.status === 'reverted') {
      throw new StarknetError('TX_REVERTED', `A rede recusou a transferência (${txHash}).`);
    }
    if (out.status === 'rejected') throw new StarknetError('TX_REJECTED', 'A rede rejeitou a transação.');
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
