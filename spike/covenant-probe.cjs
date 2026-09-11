/**
 * Does `covenantId` survive the WASM client?
 *
 * This is the one measurement that decides how far @warda_protocol/borsh can
 * go. A vendor reading its own payments does not need the field — a payment is
 * an ordinary P2PK output. Reading a GRANT does. If the field comes back here,
 * borsh can serve grant reads too and the reader's CovenantUnanswerable goes
 * away; if it does not, the read-only-for-payments scope is the real ceiling.
 *
 * Run it from a machine with egress to the resolvers:
 *
 *   cd spike && node covenant-probe.cjs
 *
 * Look for `covenantId` in the printed entry. Absent is a real answer.
 */
const k = require('kaspa-wasm32-sdk');

const GRANT = process.argv[2] || 'kaspatest:prw9hklems02v8apxlx5m6y0d90e0j6657ztr3c3cjqf0wsnwsxz2fs9n0jxr';

(async () => {
  const rpc = new k.RpcClient({
    resolver: new k.Resolver(),
    networkId: 'testnet-10',
    encoding: k.Encoding.Borsh,
  });
  await rpc.connect();
  console.log('url    :', rpc.url);
  console.log('grant  :', GRANT);

  const res = await rpc.getUtxosByAddresses({ addresses: [GRANT] });
  const entries = res.entries ?? res;
  console.log('entries:', entries.length);

  if (!entries.length) {
    console.log('\nNothing at that address. A spend MOVES a grant, so this usually');
    console.log('means the address is stale rather than that the grant is gone.');
    console.log('Pass a current grant address as argv[2].');
  } else {
    console.log('\nRAW ENTRY:');
    console.log(JSON.stringify(entries[0], (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    const flat = JSON.stringify(entries[0]);
    console.log('\ncovenantId present:', /covenant/i.test(flat) ? 'YES' : 'NO');
  }

  await rpc.disconnect();
})().catch((e) => { console.error('FAILED:', e.message ?? e); process.exit(1); });
