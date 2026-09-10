const k = require('kaspa-wasm32-sdk');

(async () => {
  const rpc = new k.RpcClient({
    resolver: new k.Resolver(),
    networkId: 'testnet-10',
    encoding: k.Encoding.Borsh,
  });

  await rpc.connect();
  console.log('connected to:', rpc.url);

  const dag = await rpc.getBlockDagInfo();
  console.log('network     :', dag.network);
  console.log('daa score   :', dag.virtualDaaScore);

  // the demo vendor — should show the coins your agents have paid it
  const res = await rpc.getUtxosByAddresses({ addresses: [
    'kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4',
  ]});
  const entries = res.entries ?? res;
  console.log('vendor coins:', entries.length);
  if (entries[0]) console.log('first coin  :', entries[0].amount ?? entries[0].utxoEntry?.amount);

  await rpc.disconnect();
})().catch((e) => { console.error('FAILED:', e.message ?? e); process.exit(1); });
