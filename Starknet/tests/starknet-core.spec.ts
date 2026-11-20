// tests/starknet-core.spec.ts — núcleo Starknet (PoC Seed Grant), OFFLINE.
// Rodar: npx tsx tests/starknet-core.spec.ts   (ou npm run test:starknet)
//
// Vetores da frase PÚBLICA de teste do BIP39 "abandon ×11 about" (nunca usar
// com fundos). Os valores esperados NÃO vieram do módulo: foram calculados em
// 20/11/2026 por duas referências independentes que não compartilham código
// com ethers/starknet.js/@scure — Python (biblioteca padrão: BIP39, BIP32,
// grind e curva Stark escritos à mão) e Rust (starknet-crypto 0.8.1 +
// starknet-core 0.16.0). Tabela e método em README.md.
// Se este teste falhar, corrija o código — nunca o vetor.
import assert from 'node:assert/strict';
import {
  OZ_ACCOUNT_CLASS_HASH,
  StarknetError,
  __resetStarknetSendQueue,
  checkStarknetAddress,
  computeStarknetAccountAddress,
  deriveStarknetAccountFromMnemonic,
  formatStarknetAmount,
  getStarknetBalances,
  getStarknetAccountState,
  getStarknetExplorerTxUrl,
  getStarknetRpcUrls,
  grindStarkKey,
  parseStarknetAmount,
  publicStarknetAccount,
  sendStarknetToken,
  signStarknetHash,
  starknetAccountFromPrivateKey,
  starknetEstimationKeys,
  verifyStarknetHash,
  STARKNET_TOKENS,
} from '../src/starknet';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const VECTORS = [
  {
    index: 0,
    path: "m/44'/9004'/0'/0/0",
    privateKey: '0x001b8e16cdf31892c56c0370f0e4ca0da096ef4e0c81007b3ba10b11452f8971',
    publicKey: '0x05d97a4a9174d9158c3886717a70112c5e60b17318a1d3ae17f563f1cf8292f4',
    address: '0x04ee2ac5d0f2a340c244235e06d162e7272a938742696cb66f814e1a334c76d2',
  },
  {
    index: 1,
    path: "m/44'/9004'/0'/0/1",
    privateKey: '0x06d582b352685f7c37a2faa748536c741c3a8c660cb011bce57457a32cd04d1a',
    publicKey: '0x03810eab057111f997455e907854d499c312910eed85b6597adff08c56e8b5ea',
    address: '0x00cb064ea1d78165d671e1303036a657b197b287481807d1442d10fa1ef52f5b',
  },
  {
    index: 2,
    path: "m/44'/9004'/0'/0/2",
    privateKey: '0x02fc51936e38cc0298263303d3a18602f076b1331e5fd239a00c0a91419af398',
    publicKey: '0x0708f3abc86129a3ebd0a34e6637dae2da8a5c7b8d09323b673bb5df19619b6c',
    address: '0x029c0394792551af2120ea912ed40d6bfe32770c0cb9003466479cd18b7b9e21',
  },
];

// Sementes em que o 1º sha256 cai acima do limite: o grind precisa de 2+ voltas.
const GRIND_VECTORS = [
  ['0xfafc5631b95d443499527122dac2ca7f224fe0c863138b2cb1b3103a7a05fa7d', '0x03f19f12816466657fa90ad52b997cc32d2f78a1dc561014a509af77ded59004'],
  ['0xa3c66169794256420479fc85b5dcd8405f688965a387e35027b8ae4a2ae1f450', '0x005ecf9397551f82b2cd6b301029939e0f6f1085526a27cd9f07e384e5cef0e1'],
];

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

async function expectCode(p: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    assert.ok(err instanceof StarknetError, `esperava StarknetError, veio ${(err as any)?.message}`);
    assert.equal((err as StarknetError).code, code);
    return;
  }
  assert.fail(`esperava erro ${code}`);
}

// ---------------------------------------------------------------------------
// Nó JSON-RPC simulado
type Rpc = { method: string; params: any; url: string };
const rpcLog: Rpc[] = [];
const bodies: string[] = [];
const allBodies: string[] = [];
const sim = {
  deployed: true,
  balances: { ETH: 0n, STRK: 0n } as Record<string, bigint>,
  failUrls: new Set<string>(),
  receipt: 'SUCCEEDED' as 'SUCCEEDED' | 'REVERTED',
  estimateRevertsWith: '' as string,
};

const FEE = {
  l1_gas_consumed: '0x0', l1_gas_price: '0x1',
  l2_gas_consumed: '0x100000', l2_gas_price: '0x2540be400', // 1.048.576 × 10 gwei
  l1_data_gas_consumed: '0x100', l1_data_gas_price: '0x3b9aca00',
  overall_fee: '0x9c4000000000', unit: 'FRI',
};

function rpcResult(req: { method: string; params: any }, url: string): { result?: any; error?: any } {
  switch (req.method) {
    case 'starknet_specVersion': return { result: '0.9.0' };
    case 'starknet_chainId': return { result: '0x534e5f5345504f4c4941' };
    case 'starknet_getClassHashAt':
      return sim.deployed ? { result: OZ_ACCOUNT_CLASS_HASH } : { error: { code: 20, message: 'Contract not found' } };
    case 'starknet_getClassAt':
      return sim.deployed ? { result: { sierra_program: [], contract_class_version: '0.1.0', entry_points_by_type: {}, abi: '[]' } } : { error: { code: 20, message: 'Contract not found' } };
    case 'starknet_call': {
      const token = Object.entries(STARKNET_TOKENS).find(([, t]) => BigInt(t.address) === BigInt(req.params.request.contract_address))?.[0];
      const v = sim.balances[token || ''] ?? 0n;
      return { result: ['0x' + (v & ((1n << 128n) - 1n)).toString(16), '0x' + (v >> 128n).toString(16)] };
    }
    case 'starknet_estimateFee':
      if (sim.estimateRevertsWith) return { error: { code: 41, message: 'Transaction execution error', data: { execution_error: sim.estimateRevertsWith } } };
      return { result: req.params.request.map(() => FEE) };
    case 'starknet_getNonce': return { result: '0x0' };
    case 'starknet_blockNumber': return { result: 100 };
    case 'starknet_getBlockWithTxs':
    case 'starknet_getBlockWithTxHashes':
      return { result: { status: 'ACCEPTED_ON_L2', block_number: 100, block_hash: '0x1', parent_hash: '0x0', timestamp: 1, sequencer_address: '0x1', transactions: [], l1_gas_price: { price_in_fri: '0x1', price_in_wei: '0x1' }, l2_gas_price: { price_in_fri: '0x1', price_in_wei: '0x1' }, l1_data_gas_price: { price_in_fri: '0x1', price_in_wei: '0x1' }, l1_da_mode: 'BLOB', starknet_version: '0.14.0' } };
    case 'starknet_addInvokeTransaction': return { result: { transaction_hash: '0xabc1' } };
    case 'starknet_addDeployAccountTransaction': return { result: { transaction_hash: '0xde91', contract_address: VECTORS[0].address } };
    case 'starknet_getTransactionStatus':
      return { result: { finality_status: 'ACCEPTED_ON_L2', execution_status: sim.receipt } };
    case 'starknet_getTransactionReceipt':
      return {
        result: {
          type: 'INVOKE', transaction_hash: req.params.transaction_hash, actual_fee: { amount: '0x5000', unit: 'FRI' },
          execution_status: sim.receipt, finality_status: 'ACCEPTED_ON_L2', block_number: 101, block_hash: '0x2',
          messages_sent: [], events: [], execution_resources: { l1_gas: 0, l2_gas: 1, l1_data_gas: 1 },
          ...(sim.receipt === 'REVERTED' ? { revert_reason: 'ERC20: insufficient balance' } : {}),
        },
      };
    default: return { error: { code: -32601, message: `simulador não conhece ${req.method}` } };
  }
}

(globalThis as any).fetch = async (input: any, init?: any): Promise<Response> => {
  const url = typeof input === 'string' ? input : String(input?.url || input);
  const body = String(init?.body || '');
  bodies.push(body);
  allBodies.push(body);
  if (sim.failUrls.has(url)) return new Response('bad gateway', { status: 502 });
  const parsed = JSON.parse(body);
  const one = (r: any) => {
    rpcLog.push({ method: r.method, params: r.params, url });
    return { jsonrpc: '2.0', id: r.id, ...rpcResult(r, url) };
  };
  const out = Array.isArray(parsed) ? parsed.map(one) : one(parsed);
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
};

function resetSim() {
  rpcLog.length = 0;
  bodies.length = 0;
  sim.deployed = true;
  sim.balances = { ETH: 0n, STRK: 0n };
  sim.failUrls.clear();
  sim.receipt = 'SUCCEEDED';
  sim.estimateRevertsWith = '';
  __resetStarknetSendQueue();
}

const methods = () => rpcLog.map((r) => r.method);
const RECIPIENT = VECTORS[1].address;
const ONE = 10n ** 18n;

(async () => {
  // --- Derivação e recuperação -------------------------------------------
  await test('derivação bate com as referências Python + Rust (índices 0..2)', () => {
    for (const v of VECTORS) {
      const a = deriveStarknetAccountFromMnemonic(PHRASE, v.index);
      assert.equal(a.derivationPath, v.path);
      assert.equal(a.privateKey, v.privateKey);
      assert.equal(a.publicKey, v.publicKey);
      assert.equal(a.address, v.address);
      assert.equal(a.classHash, OZ_ACCOUNT_CLASS_HASH);
    }
  });

  await test('grind com mais de uma volta bate com a referência Python', () => {
    for (const [seed, key] of GRIND_VECTORS) assert.equal(grindStarkKey(seed), key);
  });

  await test('recuperação: mesma frase (espaços/quebras extras) devolve a mesma conta', () => {
    const messy = `  ${PHRASE.split(' ').join('  \n ')}  `;
    assert.deepEqual(deriveStarknetAccountFromMnemonic(messy, 0), deriveStarknetAccountFromMnemonic(PHRASE, 0));
  });

  await test('recuperação pela chave Stark exportada devolve o mesmo endereço', () => {
    const a = starknetAccountFromPrivateKey(VECTORS[0].privateKey);
    assert.equal(a.address, VECTORS[0].address);
    assert.equal(computeStarknetAccountAddress(VECTORS[2].publicKey), VECTORS[2].address);
  });

  await test('frase inválida e chave fora da curva são recusadas', async () => {
    await expectCode(() => deriveStarknetAccountFromMnemonic('abandon abandon abandon', 0), 'INVALID_MNEMONIC');
    await expectCode(() => starknetAccountFromPrivateKey('0x0'), 'INVALID_PRIVATE_KEY');
    await expectCode(() => starknetAccountFromPrivateKey('0x0800000000000010ffffffffffffffffb781126dcae7b2321e66a241adc64d2f'), 'INVALID_PRIVATE_KEY');
  });

  await test('endereço Starknet difere do EVM da mesma frase', async () => {
    const { HDNodeWallet } = await import('ethers');
    const evm = HDNodeWallet.fromPhrase(PHRASE).address.toLowerCase();
    assert.notEqual(BigInt(VECTORS[0].address), BigInt(evm));
  });

  await test('publicStarknetAccount não carrega a chave privada', () => {
    const pub = publicStarknetAccount(deriveStarknetAccountFromMnemonic(PHRASE, 0));
    assert.ok(!JSON.stringify(pub).includes(VECTORS[0].privateKey.slice(4)));
  });

  // --- Assinatura local ---------------------------------------------------
  await test('assinatura local verifica com a chave pública e falha se adulterada', () => {
    const msg = '0x' + 'ab'.repeat(31);
    const sig = signStarknetHash(VECTORS[0].privateKey, msg);
    // r/s conferidos também pelo Rust (starknet-crypto::verify) em README.md
    assert.equal(sig.r, '0x02e02d6b15fb4453b3fd726798b97be32c5c729be3d0207762f17746d4e60ab2');
    assert.equal(sig.s, '0x0067fb98bbda54d56154d96096c9e1e17273ab52370340c34b6a5ca8f6f48d0f');
    assert.equal(verifyStarknetHash(VECTORS[0].publicKey, msg, sig), true);
    assert.equal(verifyStarknetHash(VECTORS[1].publicKey, msg, sig), false);
    assert.equal(verifyStarknetHash(VECTORS[0].publicKey, '0x' + 'ab'.repeat(30) + 'ac', sig), false);
  });

  // --- Validação de endereço / valores -------------------------------------
  await test('validação de endereço', () => {
    assert.deepEqual(checkStarknetAddress(VECTORS[1].address), { ok: true, address: VECTORS[1].address });
    // sem zeros à esquerda normaliza para 64 hex
    assert.deepEqual(checkStarknetAddress('0xcb064ea1d78165d671e1303036a657b197b287481807d1442d10fa1ef52f5b'), { ok: true, address: VECTORS[1].address });
    assert.equal(checkStarknetAddress(`  ${VECTORS[0].address.toUpperCase().replace('0X', '0x')}  `).ok, true);
    const evm = checkStarknetAddress('0x52908400098527886E0F7030069857D2E4169EE7');
    assert.equal(evm.ok, false);
    assert.equal(!evm.ok && evm.code, 'EVM_ADDRESS');
    assert.equal(checkStarknetAddress('0x0').ok, false);
    assert.equal(checkStarknetAddress('0x0800000000000000000000000000000000000000000000000000000000000000').ok, false); // = 2^251
    assert.equal(checkStarknetAddress('0x' + '1'.repeat(65)).ok, false);
    assert.equal(checkStarknetAddress('SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7').ok, false);
    assert.equal(checkStarknetAddress('').ok, false);
    // maiúsculas/minúsculas misturadas exigem checksum correto
    const mixed = '0x04ee2aC5d0f2a340c244235e06d162e7272a938742696cb66f814e1a334c76d2';
    const r = checkStarknetAddress(mixed);
    assert.equal(r.ok, false);
  });

  await test('parse/format de valores com 18 casas', async () => {
    assert.equal(parseStarknetAmount('1'), ONE);
    assert.equal(parseStarknetAmount('0,5'), ONE / 2n);
    assert.equal(parseStarknetAmount('0.000000000000000001'), 1n);
    assert.equal(formatStarknetAmount(ONE * 3n / 2n), '1.5');
    assert.equal(formatStarknetAmount(2n * ONE), '2');
    await expectCode(() => parseStarknetAmount('0'), 'INVALID_AMOUNT');
    await expectCode(() => parseStarknetAmount('-1'), 'INVALID_AMOUNT');
    await expectCode(() => parseStarknetAmount('1e3'), 'INVALID_AMOUNT');
    await expectCode(() => parseStarknetAmount('0.0000000000000000001'), 'INVALID_AMOUNT');
  });

  await test('explorador da Sepolia', () => {
    assert.equal(getStarknetExplorerTxUrl('0xabc1', 'sepolia'), `https://sepolia.voyager.online/tx/0x${'0'.repeat(60)}abc1`);
  });

  // --- Saldo / estado ------------------------------------------------------
  await test('saldo ETH e STRK lê u256 (low + high)', async () => {
    resetSim();
    sim.balances = { ETH: 5n * ONE, STRK: (1n << 130n) + 7n };
    const b = await getStarknetBalances(VECTORS[0].address, 'sepolia');
    assert.equal(b.ETH, 5n * ONE);
    assert.equal(b.STRK, (1n << 130n) + 7n);
    assert.ok(rpcLog.every((r) => r.method !== 'starknet_call' || r.params.request.entry_point_selector));
  });

  await test('estado da conta: implantada x não implantada', async () => {
    resetSim();
    assert.deepEqual(await getStarknetAccountState(VECTORS[0].address, 'sepolia'), { deployed: true, classHash: OZ_ACCOUNT_CLASS_HASH });
    sim.deployed = false;
    assert.deepEqual(await getStarknetAccountState(VECTORS[0].address, 'sepolia'), { deployed: false, classHash: null });
  });

  await test('leitura cai para o próximo RPC quando o primeiro está fora', async () => {
    resetSim();
    const [first, second] = getStarknetRpcUrls('sepolia');
    sim.failUrls.add(first);
    sim.balances.ETH = 9n;
    const b = await getStarknetBalances(VECTORS[0].address, 'sepolia');
    assert.equal(b.ETH, 9n);
    assert.ok(rpcLog.some((r) => r.url === second));
  });

  await test('mainnet desligada na PoC: falha antes de qualquer requisição', async () => {
    resetSim();
    await expectCode(getStarknetBalances(VECTORS[0].address, 'mainnet'), 'NETWORK_DISABLED');
    const keys = deriveStarknetAccountFromMnemonic(PHRASE, 0);
    await expectCode(sendStarknetToken({ keys, token: 'STRK', to: RECIPIENT, amount: 1n }, 'mainnet'), 'NETWORK_DISABLED');
    assert.equal(bodies.length, 0);
  });

  // --- Fluxo de envio ------------------------------------------------------
  const keys = deriveStarknetAccountFromMnemonic(PHRASE, 0);

  await test('envio recusa destino inválido, EVM e o próprio endereço sem tocar a rede', async () => {
    resetSim();
    await expectCode(sendStarknetToken({ keys, token: 'STRK', to: '0x52908400098527886E0F7030069857D2E4169EE7', amount: 1n }, 'sepolia'), 'EVM_ADDRESS');
    await expectCode(sendStarknetToken({ keys, token: 'STRK', to: 'abc', amount: 1n }, 'sepolia'), 'INVALID_ADDRESS');
    await expectCode(sendStarknetToken({ keys, token: 'STRK', to: keys.address, amount: 1n }, 'sepolia'), 'SELF_TRANSFER');
    await expectCode(sendStarknetToken({ keys, token: 'STRK', to: RECIPIENT, amount: 0n }, 'sepolia'), 'INVALID_AMOUNT');
    assert.equal(bodies.length, 0);
  });

  await test('saldo insuficiente: para antes de assinar/transmitir', async () => {
    resetSim();
    sim.balances = { ETH: 0n, STRK: 10n * ONE };
    await expectCode(sendStarknetToken({ keys, token: 'ETH', to: RECIPIENT, amount: 1n }, 'sepolia'), 'INSUFFICIENT_BALANCE');
    assert.ok(!methods().some((m) => m.startsWith('starknet_add')));
  });

  await test('falta STRK para a taxa: para antes de transmitir', async () => {
    resetSim();
    sim.balances = { ETH: ONE, STRK: 1n };
    await expectCode(sendStarknetToken({ keys, token: 'ETH', to: RECIPIENT, amount: ONE / 10n }, 'sepolia'), 'INSUFFICIENT_FEE_BALANCE');
    assert.ok(!methods().some((m) => m.startsWith('starknet_add')));
  });

  await test('simulação revertida por saldo vira INSUFFICIENT_BALANCE', async () => {
    resetSim();
    sim.balances = { ETH: ONE, STRK: 10n * ONE };
    sim.estimateRevertsWith = "0x45524332303a20696e73756666696369656e742062616c616e6365 ('ERC20: insufficient balance')";
    await expectCode(sendStarknetToken({ keys, token: 'ETH', to: RECIPIENT, amount: ONE / 10n }, 'sepolia'), 'INSUFFICIENT_BALANCE');
  });

  await test('envio com conta implantada: assina local, transmite 1 INVOKE e confirma', async () => {
    resetSim();
    sim.balances = { ETH: ONE, STRK: 10n * ONE };
    const res = await sendStarknetToken({ keys, token: 'STRK', to: RECIPIENT, amount: ONE }, 'sepolia');
    assert.equal(res.status, 'succeeded');
    assert.equal(res.txHash, `0x${'0'.repeat(60)}abc1`);
    assert.equal(res.blockNumber, 101);
    assert.equal(res.deployTxHash, undefined);
    assert.ok(res.explorerUrl.startsWith('https://sepolia.voyager.online/tx/0x'));
    const adds = rpcLog.filter((r) => r.method.startsWith('starknet_add'));
    assert.deepEqual(adds.map((r) => r.method), ['starknet_addInvokeTransaction']);
    const tx = adds[0].params.invoke_transaction;
    assert.equal(BigInt(tx.sender_address), BigInt(keys.address));
    assert.equal(tx.version, '0x3');
    assert.equal(tx.signature.length, 2);
    const cd = tx.calldata.map((x: string) => BigInt(x));
    assert.ok(cd.includes(BigInt(STARKNET_TOKENS.STRK.address)));
    assert.ok(cd.includes(BigInt(RECIPIENT)));
    assert.ok(cd.includes(ONE));
    // broadcast só no 1º RPC
    assert.equal(adds[0].url, getStarknetRpcUrls('sepolia')[0]);
  });

  await test('conta não implantada: DEPLOY_ACCOUNT antes do INVOKE', async () => {
    resetSim();
    sim.deployed = false;
    sim.balances = { ETH: ONE, STRK: 10n * ONE };
    // depois do deploy a conta passa a existir
    const res = await (async () => {
      const p = sendStarknetToken({ keys, token: 'ETH', to: RECIPIENT, amount: ONE / 2n }, 'sepolia');
      const timer = setInterval(() => {
        if (methods().includes('starknet_addDeployAccountTransaction')) sim.deployed = true;
      }, 5);
      try { return await p; } finally { clearInterval(timer); }
    })();
    const adds = rpcLog.filter((r) => r.method.startsWith('starknet_add')).map((r) => r.method);
    assert.deepEqual(adds, ['starknet_addDeployAccountTransaction', 'starknet_addInvokeTransaction']);
    const dep = rpcLog.find((r) => r.method === 'starknet_addDeployAccountTransaction')!.params.deploy_account_transaction;
    assert.equal(BigInt(dep.class_hash), BigInt(OZ_ACCOUNT_CLASS_HASH));
    assert.equal(BigInt(dep.contract_address_salt), BigInt(keys.publicKey));
    assert.deepEqual(dep.constructor_calldata.map((x: string) => BigInt(x)), [BigInt(keys.publicKey)]);
    assert.equal(res.status, 'succeeded');
    assert.ok(res.deployTxHash);
  });

  await test('conta não implantada com autoDeploy=false: pede ativação', async () => {
    resetSim();
    sim.deployed = false;
    sim.balances = { ETH: ONE, STRK: 10n * ONE };
    await expectCode(sendStarknetToken({ keys, token: 'ETH', to: RECIPIENT, amount: 1n, autoDeploy: false }, 'sepolia'), 'ACCOUNT_NOT_DEPLOYED');
    assert.ok(!methods().some((m) => m.startsWith('starknet_add')));
  });

  await test('transação revertida vira TX_REVERTED', async () => {
    resetSim();
    sim.balances = { ETH: ONE, STRK: 10n * ONE };
    sim.receipt = 'REVERTED';
    await expectCode(sendStarknetToken({ keys, token: 'ETH', to: RECIPIENT, amount: 1n }, 'sepolia'), 'TX_REVERTED');
  });

  await test('chaves de estimativa: só dados públicos, conferem endereço e nunca transmitem', async () => {
    const est = starknetEstimationKeys(VECTORS[0].address, VECTORS[0].publicKey);
    assert.equal(est.address, VECTORS[0].address);
    assert.notEqual(est.privateKey, VECTORS[0].privateKey);
    await expectCode(() => starknetEstimationKeys(VECTORS[0].address, VECTORS[1].publicKey), 'INVALID_ADDRESS');
    resetSim();
    sim.balances = { ETH: ONE, STRK: 10n * ONE };
    await expectCode(sendStarknetToken({ keys: est, token: 'STRK', to: RECIPIENT, amount: 1n }, 'sepolia'), 'INVALID_PRIVATE_KEY');
    // chave real de OUTRA conta com o endereço desta: barrada antes da rede
    await expectCode(sendStarknetToken({ keys: { ...keys, privateKey: VECTORS[1].privateKey }, token: 'STRK', to: RECIPIENT, amount: 1n }, 'sepolia'), 'INVALID_PRIVATE_KEY');
    assert.equal(bodies.length, 0);
  });

  await test('nenhuma chave privada sai em requisição alguma', () => {
    const secrets = VECTORS.map((v) => v.privateKey.replace(/^0x0*/, '').toLowerCase());
    assert.ok(allBodies.length > 20);
    for (const b of allBodies) for (const s of secrets) assert.ok(!b.toLowerCase().includes(s), 'chave privada vazou numa requisição');
  });

  console.log(`\n${passed} testes ok`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
