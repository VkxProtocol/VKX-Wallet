// scripts/starknet-mainnet-readiness.ts — Fase 3: checagem SOMENTE LEITURA da
// configuração candidata da Starknet mainnet. Não assina, não transmite e não
// usa chave alguma. Grava docs/starknet/mainnet-readiness.json.
// Rodar: npx tsx scripts/starknet-mainnet-readiness.ts
import fs from 'node:fs';
import path from 'node:path';
import { RpcProvider, hash, byteArray } from 'starknet';
import {
  STARKNET_MAINNET_CANDIDATE,
  STARKNET_MAINNET_RELEASE_APPROVED,
  STARKNET_TOKENS,
  OZ_ACCOUNT_CLASS_HASH_V4_LEGACY,
  getStarknetRpcUrls,
  getStarknetBalances,
} from '../src/starknet';

const OUT = path.resolve(__dirname, '../evidence/mainnet-readiness.json');
const pad = (h: string) => `0x${BigInt(h).toString(16).padStart(64, '0')}`;

function decodeByteArray(r: string[]): string {
  const n = Number(r[0]);
  return byteArray.stringFromByteArray({ data: r.slice(1, 1 + n), pending_word: r[1 + n], pending_word_len: Number(r[2 + n]) } as any);
}

async function checkNode(url: string) {
  const p = new RpcProvider({ nodeUrl: url });
  const out: Record<string, unknown> = { url };
  try {
    out.chainId = await p.getChainId();
    out.chainIdOk = out.chainId === STARKNET_MAINNET_CANDIDATE.chainId;
    out.block = await p.getBlockNumber();
    const tokens: Record<string, unknown> = {};
    for (const [sym, t] of Object.entries(STARKNET_TOKENS)) {
      const s = decodeByteArray(await p.callContract({ contractAddress: t.address, entrypoint: 'symbol', calldata: [] }));
      const d = Number((await p.callContract({ contractAddress: t.address, entrypoint: 'decimals', calldata: [] }))[0]);
      tokens[sym] = { address: t.address, symbol: s, decimals: d, ok: s === sym && d === t.decimals };
    }
    out.tokens = tokens;
    const cls: any = await p.getClassByHash(STARKNET_MAINNET_CANDIDATE.accountClassHash);
    const abi = typeof cls.abi === 'string' ? JSON.parse(cls.abi) : cls.abi;
    const ctor = abi.find((i: any) => i.type === 'constructor');
    out.accountClass = {
      classHash: STARKNET_MAINNET_CANDIDATE.accountClassHash,
      declared: true,
      recomputedHashMatches: pad(hash.computeSierraContractClassHash(cls)) === pad(STARKNET_MAINNET_CANDIDATE.accountClassHash),
      constructor: ctor?.inputs?.map((i: any) => `${i.name}:${i.type}`).join(','),
    };
    try {
      await p.getClassByHash(OZ_ACCOUNT_CLASS_HASH_V4_LEGACY);
      out.sepoliaClassOnMainnet = 'declared';
    } catch {
      out.sepoliaClassOnMainnet = 'not declared (por isso o padrão é a OZ 3.x nas duas redes)';
    }
  } catch (err: any) {
    out.error = String(err?.message || err).slice(0, 200);
  }
  return out;
}

(async () => {
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    releaseApproved: STARKNET_MAINNET_RELEASE_APPROVED,
    moduleMainnetRpcUrls: getStarknetRpcUrls('mainnet'),
    candidate: STARKNET_MAINNET_CANDIDATE,
  };
  try {
    await getStarknetBalances(STARKNET_TOKENS.STRK.address, 'mainnet');
    report.moduleRefusesMainnet = false;
  } catch (err: any) {
    report.moduleRefusesMainnet = err?.code === 'NETWORK_DISABLED';
  }
  report.nodes = [];
  for (const url of STARKNET_MAINNET_CANDIDATE.rpcUrls) (report.nodes as unknown[]).push(await checkNode(url));
  fs.writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
  for (const n of report.nodes as any[]) {
    const tk = n.tokens ? Object.values(n.tokens).every((t: any) => t.ok) : false;
    console.log(`${new URL(n.url).host}: chainId ${n.chainIdOk ? 'OK' : 'FALHA'} | tokens ${tk ? 'OK' : 'FALHA'} | classe ${n.accountClass?.recomputedHashMatches ? 'OK' : 'FALHA'}${n.error ? ` | erro: ${n.error}` : ''}`);
  }
  console.log(`liberação aprovada: ${report.releaseApproved} | módulo recusa mainnet: ${report.moduleRefusesMainnet} | RPCs no módulo: ${(report.moduleMainnetRpcUrls as string[]).length}`);
})();
