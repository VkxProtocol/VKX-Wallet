// scripts/starknet-sepolia-poc.ts — PoC Starknet Sepolia usando o MESMO módulo
// do app (src/services/networks/starknet.ts). Só testnet: o módulo não tem RPC
// de mainnet.
//
// A frase de teste fica num arquivo FORA do repositório, apontado por
// STARKNET_POC_MNEMONIC_FILE. O script nunca imprime frase nem chave privada;
// as evidências só têm endereço, chave pública, hash, data e link.
//
//   npx tsx scripts/starknet-sepolia-poc.ts new        # cria a frase (se não existir)
//   npx tsx scripts/starknet-sepolia-poc.ts status     # endereços, implantação, saldos
//   npx tsx scripts/starknet-sepolia-poc.ts deploy     # implanta a conta 0
//   npx tsx scripts/starknet-sepolia-poc.ts send STRK 1 [destino]   # conta 0 -> conta 1 (padrão)
import fs from 'node:fs';
import path from 'node:path';
import { Wallet } from 'ethers';
import {
  type StarknetAccountKeys,
  type StarknetTokenSymbol,
  deployStarknetAccount,
  deriveStarknetAccountFromMnemonic,
  OZ_ACCOUNT_CLASS_HASH_V4_LEGACY,
  STARKNET_ACCOUNT_CLASS_HASH,
  estimateStarknetDeployFee,
  formatStarknetAmount,
  getStarknetAccountState,
  getStarknetBalances,
  getStarknetChainId,
  getStarknetExplorerAddressUrl,
  getStarknetExplorerTxUrl,
  parseStarknetAmount,
  publicStarknetAccount,
  sendStarknetToken,
} from '../src/starknet';

const NETWORK = 'sepolia' as const;
const EVIDENCE_FILE = path.resolve(__dirname, '../evidence/sepolia-evidence.json');

function mnemonicFile(): string {
  const f = process.env.STARKNET_POC_MNEMONIC_FILE;
  if (!f) throw new Error('Defina STARKNET_POC_MNEMONIC_FILE (arquivo fora do repositório).');
  if (path.resolve(f).toLowerCase().startsWith(path.resolve(__dirname, '..').toLowerCase())) {
    throw new Error('A frase de teste não pode ficar dentro do repositório.');
  }
  return f;
}

// Padrão: classe OZ 3.x (opção C). --legado: contas antigas da PoC (classe 4.x).
const LEGACY = process.argv.includes('--legado');
const CLASS = LEGACY ? OZ_ACCOUNT_CLASS_HASH_V4_LEGACY : STARKNET_ACCOUNT_CLASS_HASH;

function loadAccounts(): { a0: StarknetAccountKeys; a1: StarknetAccountKeys } {
  const phrase = fs.readFileSync(mnemonicFile(), 'utf8').trim();
  return { a0: deriveStarknetAccountFromMnemonic(phrase, 0, CLASS), a1: deriveStarknetAccountFromMnemonic(phrase, 1, CLASS) };
}

function appendEvidence(entry: Record<string, unknown>) {
  const list = fs.existsSync(EVIDENCE_FILE) ? JSON.parse(fs.readFileSync(EVIDENCE_FILE, 'utf8')) : [];
  list.push({ at: new Date().toISOString(), network: 'starknet-sepolia', chainId: getStarknetChainId(NETWORK), ...entry });
  fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
  fs.writeFileSync(EVIDENCE_FILE, `${JSON.stringify(list, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
}

const fmt = (b: Record<string, bigint>) => Object.entries(b).map(([k, v]) => `${formatStarknetAmount(v)} ${k}`).join(' | ');

async function status() {
  const { a0, a1 } = loadAccounts();
  const out: any[] = [];
  for (const [label, a] of [['conta 0', a0], ['conta 1', a1]] as const) {
    const [state, bal] = await Promise.all([getStarknetAccountState(a.address, NETWORK), getStarknetBalances(a.address, NETWORK)]);
    console.log(`${label}: ${a.address}`);
    console.log(`   implantada: ${state.deployed ? 'sim' : 'não'} | saldo: ${fmt(bal)}`);
    console.log(`   ${getStarknetExplorerAddressUrl(a.address, NETWORK)}`);
    out.push({ label, ...publicStarknetAccount(a), deployed: state.deployed, balances: bal });
  }
  return out;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2).filter((a) => a !== '--legado');
  if (cmd === 'new') {
    const f = mnemonicFile();
    if (fs.existsSync(f)) return console.log('Frase de teste já existe; nada feito.');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Wallet.createRandom().mnemonic!.phrase, { mode: 0o600 });
    console.log('Frase de teste criada (não impressa).');
    await status();
    return;
  }
  if (cmd === 'status') {
    const s = await status();
    if (args.includes('--registrar')) appendEvidence({ kind: 'status', accounts: s });
    return;
  }
  if (cmd === 'deploy') {
    const { a0 } = loadAccounts();
    const quote = await estimateStarknetDeployFee(a0, NETWORK);
    console.log(`Taxa máxima da ativação: ${formatStarknetAmount(quote.maxFee)} STRK`);
    const res = await deployStarknetAccount(a0, NETWORK, { wait: true });
    if (res.alreadyDeployed) return console.log('Conta 0 já estava implantada.');
    console.log(`Implantada: ${res.txHash} (${res.status}, bloco ${res.blockNumber}, taxa ${res.actualFee != null ? formatStarknetAmount(res.actualFee) : '?'} STRK)`);
    console.log(getStarknetExplorerTxUrl(res.txHash, NETWORK));
    appendEvidence({
      kind: 'deploy_account', address: a0.address, publicKey: a0.publicKey, classHash: a0.classHash,
      txHash: res.txHash, result: res.status, finality: res.finality, blockNumber: res.blockNumber,
      actualFeeFri: res.actualFee, explorer: getStarknetExplorerTxUrl(res.txHash, NETWORK),
    });
    return;
  }
  if (cmd === 'send') {
    const { a0, a1 } = loadAccounts();
    const token = (args[0] || 'STRK').toUpperCase() as StarknetTokenSymbol;
    if (token !== 'ETH' && token !== 'STRK') throw new Error('Token: ETH ou STRK.');
    const amount = parseStarknetAmount(args[1] || '1');
    const to = args[2] || a1.address;
    const before = await getStarknetBalances(to, NETWORK);
    const res = await sendStarknetToken({ keys: a0, token, to, amount, autoDeploy: true, wait: true }, NETWORK);
    const after = await getStarknetBalances(to, NETWORK);
    const received = after[token] - before[token];
    console.log(`Envio: ${res.txHash} (${res.status}, bloco ${res.blockNumber})`);
    if (res.deployTxHash) console.log(`   (conta implantada antes: ${res.deployTxHash})`);
    console.log(`   destino recebeu ${formatStarknetAmount(received)} ${token}`);
    console.log(`   ${res.explorerUrl}`);
    if (res.deployTxHash) {
      appendEvidence({ kind: 'deploy_account', address: a0.address, txHash: res.deployTxHash, result: 'succeeded', explorer: getStarknetExplorerTxUrl(res.deployTxHash, NETWORK) });
    }
    appendEvidence({
      kind: 'transfer', token, amount: formatStarknetAmount(amount), from: a0.address, to,
      txHash: res.txHash, result: res.status, finality: res.finality, blockNumber: res.blockNumber,
      actualFeeFri: res.actualFee, recipientBalanceBefore: before[token], recipientBalanceAfter: after[token],
      recipientReceived: formatStarknetAmount(received), explorer: res.explorerUrl,
    });
    return;
  }
  console.log('Uso: new | status [--registrar] | deploy | send <ETH|STRK> <valor> [destino]');
}

main().catch((err) => {
  console.error(`ERRO${err?.code ? ` [${err.code}]` : ''}: ${String(err?.message || err).slice(0, 400)}`);
  process.exit(1);
});
