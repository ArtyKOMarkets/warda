/**
 * /api/swap — the console's one server-side piece: ChangeNOW, with the key
 * kept off the page.
 *
 *   GET  /api/swap?op=quote&chain=Base&token=USDC&amount=100
 *   POST /api/swap?op=create   { chain, token, amount, address, refundAddress? }
 *   GET  /api/swap?op=status&id=<14 chars>
 *
 * What it is: a thin, allow-listed proxy. Only the pairs in routes.json can be
 * quoted or created, only to a Kaspa MAINNET address whose checksum verifies
 * (the same decoder the page uses — site/src/router-browser.js), and only
 * within ChangeNOW's own min/max for the pair.
 *
 * What it is not: a custodian, a database, or a party to the swap. It holds no
 * funds and stores nothing — no addresses, no exchange ids. The page keeps the
 * id; ChangeNOW keeps the exchange. The money goes from the person's wallet to
 * ChangeNOW's deposit address and from ChangeNOW to the person's Kaspa
 * address, and never through here.
 *
 * Environment:
 *   CHANGENOW_API_KEY          required; without it every call answers 503
 *   CHANGENOW_PARTNER_FEE_PCT  what the ChangeNOW dashboard is set to earn
 *                              this key, shown to the person on every quote.
 *                              Warda's position is 0; the page says whatever
 *                              this says, so it must match the dashboard.
 */
import fs from "node:fs";
import vm from "node:vm";

const BASE = "https://api.changenow.io/v2";
const KEY = process.env.CHANGENOW_API_KEY || "";
/* Shown to the person on every quote, so it is echoed ONLY when it is a
   percentage. Anything else — a key pasted into the wrong variable, which
   happened on the first deploy — is withheld, and the page refuses to create
   a swap until the fee is stated. An environment value is never echoed raw. */
const FEE_RAW = (process.env.CHANGENOW_PARTNER_FEE_PCT || "").trim();
const FEE = /^\d{1,2}(\.\d{1,3})?$/.test(FEE_RAW) ? FEE_RAW : null;

/* Both inputs are INLINED by site/build.py when it writes site/web/api/.
   Reading them from disk at runtime depended on the host's bundler noticing
   the read and shipping the files; on Vercel it did not, and every call
   answered 500 before this line had a chance to say why. The disk read stays
   as the fallback for running the source file directly. */
const ROUTES_INLINE = {
  "_comment": "Ways into KAS, route by route and leg by leg, and whether each works. Read by /app's Fund an agent. A route is only as available as its worst leg; the page offers every route a source chain has, and prefers the one with no custodian. checkedAt older than 14 days and /app shows every leg as unchecked. The igra-hyperlane leg's status is set by ops/check-routes.mjs, which reads the pause on-chain.",
  "checkedAt": "2026-09-25",
  "networks": {
    "testnet-10": {
      "none": "Igra's Galleon testnet has no USDC venue and no published exit bridge to Kaspa testnet-10, and no swap service trades testnet KAS, so there is no way in from a stablecoin on testnet. Testnet KAS comes from a faucet.",
      "faucet": "https://faucet.zealousswap.com/"
    },
    "mainnet": {
      "sources": [
        {
          "chain": "Base",
          "chainId": 8453,
          "tokens": [
            "USDC"
          ],
          "routes": [
            "igra",
            "changenow",
            "dymension"
          ],
          "changenow": {
            "USDC": {
              "currency": "usdc",
              "network": "base",
              "legacy": "usdcbase"
            }
          },
          "rpc": [
            "https://base-rpc.publicnode.com",
            "https://1rpc.io/base",
            "https://mainnet.base.org"
          ],
          "contracts": {
            "USDC": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
          }
        },
        {
          "chain": "Ethereum",
          "chainId": 1,
          "tokens": [
            "USDC",
            "USDT"
          ],
          "routes": [
            "igra",
            "changenow",
            "dymension"
          ],
          "changenow": {
            "USDC": {
              "currency": "usdc",
              "network": "eth",
              "legacy": "usdc"
            },
            "USDT": {
              "currency": "usdt",
              "network": "eth",
              "legacy": "usdterc20"
            }
          },
          "rpc": [
            "https://ethereum-rpc.publicnode.com",
            "https://1rpc.io/eth"
          ],
          "contracts": {
            "USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            "USDT": "0xdAC17F958D2ee523a2206206994597C13D831ec7"
          }
        },
        {
          "chain": "Arbitrum",
          "chainId": 42161,
          "tokens": [
            "USDC",
            "USDT"
          ],
          "routes": [
            "igra",
            "changenow"
          ],
          "changenow": {
            "USDC": {
              "currency": "usdc",
              "network": "arbitrum",
              "legacy": "usdcarb"
            },
            "USDT": {
              "currency": "usdt",
              "network": "arbitrum",
              "legacy": "usdtarb"
            }
          },
          "tokenRoutes": {
            "USDT": [
              "changenow"
            ]
          },
          "rpc": [
            "https://arbitrum-one-rpc.publicnode.com",
            "https://1rpc.io/arb",
            "https://arb1.arbitrum.io/rpc"
          ],
          "contracts": {
            "USDC": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
            "USDT": "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9"
          }
        },
        {
          "chain": "Optimism",
          "chainId": 10,
          "tokens": [
            "USDC",
            "USDT"
          ],
          "routes": [
            "igra",
            "changenow"
          ],
          "changenow": {
            "USDC": {
              "currency": "usdc",
              "network": "op",
              "legacy": "usdcop"
            },
            "USDT": {
              "currency": "usdt",
              "network": "op",
              "legacy": "usdtop"
            }
          },
          "tokenRoutes": {
            "USDT": [
              "changenow"
            ]
          },
          "rpc": [
            "https://optimism-rpc.publicnode.com",
            "https://1rpc.io/op",
            "https://mainnet.optimism.io"
          ],
          "contracts": {
            "USDC": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
            "USDT": "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58"
          }
        },
        {
          "chain": "Polygon",
          "chainId": 137,
          "tokens": [
            "USDC",
            "USDT"
          ],
          "routes": [
            "igra",
            "changenow"
          ],
          "changenow": {
            "USDC": {
              "currency": "usdc",
              "network": "matic",
              "legacy": "usdcmatic"
            },
            "USDT": {
              "currency": "usdt",
              "network": "matic",
              "legacy": "usdtmatic"
            }
          },
          "tokenRoutes": {
            "USDT": [
              "changenow"
            ]
          },
          "rpc": [
            "https://polygon-bor-rpc.publicnode.com",
            "https://1rpc.io/matic",
            "https://polygon-rpc.com"
          ],
          "contracts": {
            "USDC": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
            "USDT": "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"
          }
        },
        {
          "chain": "Avalanche",
          "chainId": 43114,
          "tokens": [
            "USDC",
            "USDT"
          ],
          "routes": [
            "igra",
            "changenow"
          ],
          "changenow": {
            "USDC": {
              "currency": "usdc",
              "network": "avaxc",
              "legacy": "usdcarc20"
            },
            "USDT": {
              "currency": "usdt",
              "network": "avaxc",
              "legacy": "usdtarc20"
            }
          },
          "tokenRoutes": {
            "USDT": [
              "changenow"
            ]
          },
          "rpc": [
            "https://avalanche-c-chain-rpc.publicnode.com",
            "https://1rpc.io/avax/c",
            "https://api.avax.network/ext/bc/C/rpc"
          ],
          "contracts": {
            "USDC": "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E",
            "USDT": "0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7"
          }
        },
        {
          "chain": "BNB Chain",
          "chainId": 56,
          "tokens": [
            "USDT",
            "USDC"
          ],
          "routes": [
            "changenow",
            "dymension"
          ],
          "changenow": {
            "USDT": {
              "currency": "usdt",
              "network": "bsc",
              "legacy": "usdtbsc"
            },
            "USDC": {
              "currency": "usdc",
              "network": "bsc",
              "legacy": "usdcbsc"
            }
          },
          "rpc": [
            "https://bsc-rpc.publicnode.com",
            "https://1rpc.io/bnb",
            "https://bsc-dataseed.bnbchain.org"
          ],
          "contracts": {
            "USDC": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
            "USDT": "0x55d398326f99059fF775485246999027B3197955"
          }
        },
        {
          "chain": "Igra",
          "chainId": 38833,
          "tokens": [
            "USDC"
          ],
          "routes": [
            "igra-local"
          ]
        }
      ],
      "routes": {
        "igra": {
          "name": "Through Igra",
          "custody": "none",
          "summary": "Bridge to Igra, swap there, cross to Kaspa L1. Every step is a transaction you sign; nobody holds the money in between.",
          "legs": [
            "hyperlane",
            "zealous",
            "exit"
          ]
        },
        "igra-local": {
          "name": "Already on Igra",
          "custody": "none",
          "summary": "Swap on Igra and cross to Kaspa L1. No bridge in, so the Hyperlane pause does not touch it.",
          "legs": [
            "zealous",
            "exit"
          ]
        },
        "changenow": {
          "name": "Instant swap",
          "custody": "ChangeNOW",
          "summary": "Send the stablecoin to ChangeNOW; it sends native KAS to your Kaspa address. ChangeNOW holds the money for the minutes of the swap, and its fee is inside the rate it quotes. Warda takes nothing and never sees it.",
          "legs": [
            "changenow"
          ]
        },
        "dymension": {
          "name": "Dymension bridge",
          "custody": "a validator multisig (5 of 9)",
          "summary": "Swap to wrapped KAS, bridge through Dymension's Hub, released as native KAS on L1. The Kaspa leg is tested; every EVM leg is experimental.",
          "legs": [
            "dymension-evm",
            "dymension-kaspa"
          ]
        }
      },
      "legs": {
        "hyperlane": {
          "does": "bridge the stablecoin to Igra",
          "via": "Hyperlane warp route",
          "status": "paused",
          "since": "2026-09-20",
          "why": "Igra's Hyperlane pausable ISM and hook were paused on-chain, halting transfers in and out of Igra; Hyperlane removed Igra's routes from its UI and router the same day. No cause or date to resume has been published.",
          "source": "https://github.com/hyperlane-xyz/hyperlane-registry/pull/1713",
          "probe": {
            "rpc": "https://rpc.igralabs.com:8545",
            "chainId": 38833,
            "paused": [
              "0x238b3Fc6f3D32102AA655984059A051647DA98e2",
              "0x74B2b1fC57B28e11A5bAf32a758bbC98FA7837da"
            ]
          }
        },
        "zealous": {
          "does": "swap USDC for iKAS on Igra",
          "via": "Zealous Swap, USDC/iKAS pool",
          "status": "live",
          "why": "Trading, with a thin pool relative to the rest of the venue — a large order moves the price, which is what the slippage bound is for.",
          "source": "https://www.coingecko.com/en/exchanges/zealous-swap-igra"
        },
        "exit": {
          "does": "cross iKAS from Igra to KAS on Kaspa L1",
          "via": "Igra KasExitBridge",
          "status": "live",
          "minKas": 1000,
          "why": "Moves 1,000 KAS or more per exit, so a smaller funding cannot cross on its own."
        },
        "changenow": {
          "does": "swap the stablecoin for native KAS, delivered to your Kaspa address",
          "via": "ChangeNOW",
          "status": "live",
          "custodial": true,
          "why": "Custodial for the minutes of the swap: ChangeNOW receives the stablecoin and sends native KAS to your Kaspa address. Its fee is inside the rate it quotes. No 1,000 KAS floor — the minimum is under a dollar.",
          "source": "https://changenow.io/currencies/kaspa"
        },
        "dymension-evm": {
          "does": "swap to wrapped KAS and bridge it to Dymension's Hub",
          "via": "Dymension bridge (Hyperlane, Dymension's own deployment)",
          "status": "experimental",
          "why": "Marked experimental by Dymension. Liquidity for wrapped KAS on the source chain is not established.",
          "source": "https://github.com/dymensionxyz/bridge-sdk"
        },
        "dymension-kaspa": {
          "does": "release native KAS from escrow on Kaspa L1",
          "via": "Dymension Kaspa bridge",
          "status": "live",
          "why": "Hub to Kaspa is the one leg Dymension marks as manually tested. Escrow is a 5-of-9 validator multisig.",
          "source": "https://github.com/dymensionxyz/bridge-sdk"
        }
      }
    }
  },
  "_changenow_comment": "ChangeNOW v2 names a currency and a network separately (usdc + base); legacy is the combined ticker its website uses. Verified against GET /v2/exchange/currencies on 21 Sep 2026."
};
const ROUTER_INLINE = "/* GENERATED by ops/build-core-browser.mjs from @warda_protocol/router.\n   Do not edit: it is overwritten, and editing it would create the second\n   copy of the rules this file exists to prevent.\n   Rebuild:  node ops/build-core-browser.mjs  */\n\"use strict\";\nvar WardaRouter = (() => {\n  var __defProp = Object.defineProperty;\n  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;\n  var __getOwnPropNames = Object.getOwnPropertyNames;\n  var __hasOwnProp = Object.prototype.hasOwnProperty;\n  var __export = (target, all) => {\n    for (var name in all)\n      __defProp(target, name, { get: all[name], enumerable: true });\n  };\n  var __copyProps = (to, from, except, desc) => {\n    if (from && typeof from === \"object\" || typeof from === \"function\") {\n      for (let key of __getOwnPropNames(from))\n        if (!__hasOwnProp.call(to, key) && key !== except)\n          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });\n    }\n    return to;\n  };\n  var __toCommonJS = (mod) => __copyProps(__defProp({}, \"__esModule\", { value: true }), mod);\n\n  // ops/router-browser-entry.js\n  var router_browser_entry_exports = {};\n  __export(router_browser_entry_exports, {\n    GALLEON_TESTNET: () => GALLEON_TESTNET,\n    IGRA_MAINNET: () => IGRA_MAINNET,\n    MIN_EXIT_SOMPI: () => MIN_EXIT_SOMPI,\n    decodeAddress: () => decodeAddress,\n    missingFrom: () => missingFrom,\n    planFunding: () => planFunding,\n    pubkeyToAddress: () => pubkeyToAddress,\n    quote: () => quote,\n    verdict: () => verdict,\n    zoneOf: () => zoneOf\n  });\n\n  // src/amounts.ts\n  var SOMPI_PER_KAS = 100000000n;\n  function formatKas(sompi) {\n    const neg = sompi < 0n;\n    const v = neg ? -sompi : sompi;\n    const whole = v / SOMPI_PER_KAS;\n    const frac = (v % SOMPI_PER_KAS).toString().padStart(8, \"0\").replace(/0+$/, \"\");\n    return `${neg ? \"-\" : \"\"}${whole}${frac ? \".\" + frac : \"\"}`;\n  }\n\n  // src/merkle.ts\n  var LEAF = new Uint8Array([1]);\n  var NODE = new Uint8Array([2]);\n\n  // router/src/quote.ts\n  var STORAGE_MASS_FLOOR_SOMPI = 2000000n;\n  var SCALE_DP = 18;\n  var SCALE = 10n ** BigInt(SCALE_DP);\n  function parseScaled(s, what) {\n    if (typeof s !== \"string\" || !/^\\d+(\\.\\d+)?$/.test(s)) {\n      throw new Error(`${what} must be a non-negative decimal string, got ${JSON.stringify(s)}`);\n    }\n    const [whole = \"0\", frac = \"\"] = s.split(\".\");\n    if (frac.length > SCALE_DP) {\n      throw new Error(`${what} has more than ${SCALE_DP} decimal places: ${s}`);\n    }\n    return BigInt(whole) * SCALE + BigInt(frac.padEnd(SCALE_DP, \"0\") || \"0\");\n  }\n  function ceilDiv(a, b) {\n    return (a + b - 1n) / b;\n  }\n  function quote(input) {\n    const { price, rate, expiresAt } = input;\n    const slippageBps = input.slippageBps ?? 0;\n    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 1e4) {\n      throw new Error(`slippageBps must be an integer in 0..10000, got ${slippageBps}`);\n    }\n    if (!Number.isFinite(expiresAt)) {\n      throw new Error(\"expiresAt must be a unix-millisecond timestamp\");\n    }\n    let sompi;\n    let used;\n    if (price.asset === \"KAS\") {\n      if (rate) throw new Error(\"a KAS price needs no rate; pass one only when converting\");\n      sompi = ceilDiv(parseScaled(price.amount, \"price.amount\") * SOMPI_PER_KAS, SCALE);\n      used = null;\n    } else {\n      if (!rate) {\n        throw new Error(`price is in ${price.asset}, so a rate is required to reach sompi`);\n      }\n      if (rate.asset !== price.asset) {\n        throw new Error(\n          `rate is against ${rate.asset} but the price is in ${price.asset}; converting between them would be inventing a second rate nobody stated`\n        );\n      }\n      const rateScaled = parseScaled(rate.perKas, \"rate.perKas\");\n      if (rateScaled === 0n) throw new Error(\"rate.perKas is zero; no amount of KAS buys anything\");\n      const priceScaled = parseScaled(price.amount, \"price.amount\");\n      sompi = ceilDiv(priceScaled * SOMPI_PER_KAS, rateScaled);\n      used = rate;\n    }\n    const maxSompi = ceilDiv(sompi * BigInt(1e4 + slippageBps), 10000n);\n    const minSompi = sompi * BigInt(1e4 - slippageBps) / 10000n;\n    if (sompi < STORAGE_MASS_FLOOR_SOMPI) {\n      throw new Error(\n        `${price.amount} ${price.asset} converts to ${sompi} sompi, below Kaspa's ~${STORAGE_MASS_FLOOR_SOMPI} sompi storage-mass floor. There is no transaction this small, so no buyer could pay it. A price denominated in ${price.asset} has a KAS floor that moves with the market; this listing has crossed it.`\n      );\n    }\n    return { price, sompi, maxSompi, minSompi, slippageBps, rate: used, expiresAt, zone: \"attested\" };\n  }\n\n  // router/src/route.ts\n  function zoneOf(hop) {\n    if (hop.kind === \"covenant\") return \"enforced\";\n    return hop.kind === \"bridge\" || hop.kind === \"swap\" ? \"assumed\" : \"attested\";\n  }\n  var RANK = { enforced: 2, attested: 1, assumed: 0 };\n  var ALWAYS_ENFORCED = [\n    \"budgetTotal\",\n    \"maxPerSpend\",\n    \"epochLimit\",\n    \"notBefore/expiresAt\",\n    \"delegationDepth\"\n  ];\n  function covenantIndices(route) {\n    const out = [];\n    route.hops.forEach((h, i) => {\n      if (h.kind === \"covenant\") out.push(i);\n    });\n    return out;\n  }\n  function verdict(route) {\n    const hops = route.hops;\n    if (hops.length === 0) throw new Error(\"a route with no hops moves nothing\");\n    const cov = covenantIndices(route);\n    if (cov.length === 0) {\n      throw new Error(\n        \"no covenant hop on this route: nothing here was authorised by a grant, so there is no Warda claim to make about it\"\n      );\n    }\n    if (cov.length > 1) {\n      throw new Error(\n        `${cov.length} covenant hops on one route: that is ${cov.length} payments described as one, and any single verdict over them would blend different grants' limits`\n      );\n    }\n    for (const h of hops) {\n      if (h.kind === \"covenant\" && h.counterparty !== null) {\n        throw new Error(\n          `the covenant hop names ${h.counterparty} as a counterparty. If somebody can make it go wrong it is not the covenant hop \\u2014 consensus refuses every alternative or this is mislabelled`\n        );\n      }\n      if (h.kind !== \"covenant\" && h.counterparty === null) {\n        throw new Error(\n          `a ${h.kind} hop with no counterparty: somebody is on the other side of it, and a receipt that cannot name them cannot be checked`\n        );\n      }\n    }\n    const covIdx = cov[0];\n    const recipientEnforced = covIdx === hops.length - 1;\n    let weakest = \"enforced\";\n    for (const h of hops) {\n      const z = zoneOf(h);\n      if (RANK[z] < RANK[weakest]) weakest = z;\n    }\n    const counterparties = [];\n    for (const h of hops) if (h.counterparty && !counterparties.includes(h.counterparty)) counterparties.push(h.counterparty);\n    const layers = [];\n    for (const h of hops) if (!layers.includes(h.layer)) layers.push(h.layer);\n    return {\n      zone: weakest,\n      recipientEnforced,\n      authorisedToPayMe: recipientEnforced ? \"yes\" : \"unknown\",\n      counterparties,\n      layers,\n      stillEnforced: [...ALWAYS_ENFORCED]\n    };\n  }\n\n  // router/src/igra.ts\n  var GALLEON_TESTNET = {\n    name: \"galleon-testnet\",\n    chainId: 38836,\n    rpcUrl: \"https://galleon-testnet.igralabs.com:8545\",\n    explorer: \"https://explorer.galleon-testnet.igralabs.com\",\n    nativeSymbol: \"iKAS\",\n    nativeDecimals: 18\n  };\n  var IGRA_MAINNET = {\n    name: \"igra-mainnet\",\n    chainId: 38833,\n    rpcUrl: \"https://rpc.igralabs.com:8545\",\n    explorer: \"https://explorer.igralabs.com\",\n    nativeSymbol: \"iKAS\",\n    nativeDecimals: 18\n  };\n  var WEI_PER_SOMPI = 10n ** 10n;\n\n  // sdk/src/bytes.ts\n  function toHex2(b) {\n    return Array.from(b, (x) => x.toString(16).padStart(2, \"0\")).join(\"\");\n  }\n\n  // sdk/src/address.ts\n  var CHARSET = \"qpzry9x8gf2tvdw0s3jn54khce6mua7l\";\n  var AddressVersion = {\n    PubKey: 0,\n    PubKeyECDSA: 1,\n    ScriptHash: 8\n  };\n  var GENERATORS = [\n    0x98f2bc8e61n,\n    0x79b76d99e2n,\n    0xf33e5fb3c4n,\n    0xae2eabe2a8n,\n    0x1e4f43e470n\n  ];\n  function polymod(values) {\n    let c = 1n;\n    for (const d of values) {\n      const c0 = c >> 35n;\n      c = (c & 0x07ffffffffn) << 5n ^ BigInt(d);\n      for (let i = 0; i < 5; i++) {\n        if (c0 >> BigInt(i) & 1n) c ^= GENERATORS[i];\n      }\n    }\n    return c ^ 1n;\n  }\n  function prefixToFive(prefix) {\n    return Array.from(prefix, (ch) => ch.charCodeAt(0) & 31);\n  }\n  function checksum(payloadFive, prefix) {\n    return polymod([...prefixToFive(prefix), 0, ...payloadFive, 0, 0, 0, 0, 0, 0, 0, 0]);\n  }\n  function conv8to5(bytes) {\n    const src = Array.from(bytes);\n    const out = [];\n    let buff = 0;\n    let bits = 0;\n    for (const c of src) {\n      buff = buff << 8 | c;\n      bits += 8;\n      while (bits >= 5) {\n        bits -= 5;\n        out.push(buff >> bits & 31);\n        buff &= (1 << bits) - 1;\n      }\n    }\n    if (bits > 0) out.push(buff << 5 - bits & 31);\n    return out;\n  }\n  function conv5to8(five) {\n    const out = new Uint8Array(Math.floor(five.length * 5 / 8));\n    let at = 0;\n    let buff = 0;\n    let bits = 0;\n    for (const c of five) {\n      buff = buff << 5 | c;\n      bits += 5;\n      while (bits >= 8) {\n        bits -= 8;\n        out[at++] = buff >> bits & 255;\n        buff &= (1 << bits) - 1;\n      }\n    }\n    return out;\n  }\n  function encodeAddress(prefix, version, payload) {\n    const five = conv8to5([version, ...payload]);\n    const sum = checksum(five, prefix);\n    const sumBytes = new Uint8Array(5);\n    for (let i = 0; i < 5; i++) sumBytes[4 - i] = Number(sum >> BigInt(i * 8) & 0xffn);\n    const body = [...five, ...conv8to5(sumBytes)].map((c) => CHARSET[c]).join(\"\");\n    return `${prefix}:${body}`;\n  }\n  function decodeAddress(address) {\n    const colon = address.indexOf(\":\");\n    if (colon < 0) throw new Error(`address has no network prefix: ${address}`);\n    const prefix = address.slice(0, colon);\n    const body = address.slice(colon + 1);\n    if (body.length < 9) throw new Error(`address payload too short: ${address}`);\n    const five = [];\n    for (const ch of body) {\n      const i = CHARSET.indexOf(ch);\n      if (i < 0) throw new Error(`not a valid address character: '${ch}'`);\n      five.push(i);\n    }\n    const payloadFive = five.slice(0, -8);\n    const checkFive = five.slice(-8);\n    const expected = BigInt(\"0x\" + toHex2(conv5to8(checkFive)));\n    if (checksum(payloadFive, prefix) !== expected) {\n      throw new Error(`address checksum does not verify: ${address}`);\n    }\n    const bytes = conv5to8(payloadFive);\n    return { prefix, version: bytes[0], payload: bytes.slice(1) };\n  }\n  function pubkeyToAddress(xonly, prefix) {\n    if (xonly.length !== 32) throw new Error(`an x-only public key is 32 bytes, got ${xonly.length}`);\n    return encodeAddress(prefix, AddressVersion.PubKey, xonly);\n  }\n\n  // router/src/bridge.ts\n  var MIN_EXIT_SOMPI = 100000000000n;\n  var UINT64_MAX = 2n ** 64n - 1n;\n  function assertPayoutAddress(address, expectPrefix) {\n    let decoded;\n    try {\n      decoded = decodeAddress(address);\n    } catch (e) {\n      throw new Error(\n        `payout address does not verify: ${e.message}. The bridge would ACCEPT this \\u2014 it checks only the prefix and the character set, not the checksum \\u2014 and the KAS would be sent somewhere nobody holds the key to.`\n      );\n    }\n    if (expectPrefix && decoded.prefix !== expectPrefix) {\n      throw new Error(\n        `payout address is a ${decoded.prefix} address and this plan is for ${expectPrefix}. The bridge does not check which network an address belongs to either.`\n      );\n    }\n  }\n\n  // router/src/plan.ts\n  function need(cfg, what, keys) {\n    if (!cfg) return [`${what} config`];\n    return keys.filter((k) => !cfg.addresses[k]).map((k) => `${what}.addresses.${k}`);\n  }\n  function planFunding(input) {\n    const { quote: quote2, from, venue, bridge, payoutAddress, expectPrefix } = input;\n    if (payoutAddress !== void 0) assertPayoutAddress(payoutAddress, expectPrefix);\n    const swapHop = {\n      kind: \"swap\",\n      from: from.asset,\n      to: \"iKAS\",\n      layer: \"igra\",\n      counterparty: venue?.name ?? \"an unconfigured venue\"\n    };\n    const bridgeHop = {\n      kind: \"bridge\",\n      from: \"iKAS\",\n      to: \"KAS\",\n      layer: \"kaspa-l1\",\n      counterparty: bridge?.name ?? \"an unconfigured bridge\"\n    };\n    const genesisHop = {\n      kind: \"covenant\",\n      from: \"KAS\",\n      to: \"grant\",\n      layer: \"kaspa-l1\",\n      counterparty: null\n    };\n    const route = { hops: [swapHop, bridgeHop, genesisHop] };\n    const swapMissing = need(venue, \"venue\", [\"router\", \"token\"]);\n    const bridgeMissing = need(bridge, \"bridge\", [\"withdraw\"]);\n    if (payoutAddress === void 0) bridgeMissing.push(\"payoutAddress\");\n    const bridgeBlockers = quote2.sompi < MIN_EXIT_SOMPI ? [\n      `the bridge will not move ${formatKas(quote2.sompi)} KAS: its minimum exit is 1,000 KAS, so this crossing would revert with ExitAmountBelowMinimum. Crossing is a treasury operation \\u2014 cross once, fund many grants from what arrived.`\n    ] : quote2.minSompi < MIN_EXIT_SOMPI ? [\n      `at ${quote2.slippageBps / 100}% slippage as little as ${formatKas(quote2.minSompi)} KAS could arrive, under the bridge's 1,000 KAS minimum exit \\u2014 the crossing would revert if the pool fills at the bottom of the range you allowed. Cross more, or accept less slippage.`\n    ] : [];\n    const steps = [\n      {\n        index: 0,\n        hop: swapHop,\n        action: \"sign-and-submit\",\n        ready: swapMissing.length === 0,\n        missing: swapMissing,\n        blockers: [],\n        /* KAS, not sompi. The rail in exchange.ts already holds itself to \"no\n           sompi in an instruction to a human\", and its test says so; this rail\n           did not, and it showed \u2014 the console rendered \"worth at most\n           200000000000 sompi\" to somebody deciding whether to move money. */\n        describe: `swap ${from.asset} for iKAS on ${venue?.name ?? \"a venue\"}, receiving ${formatKas(quote2.sompi)} KAS at the quoted rate and no less than ${formatKas(quote2.minSompi)} KAS`\n      },\n      {\n        index: 1,\n        hop: bridgeHop,\n        action: \"sign-and-submit\",\n        ready: bridgeMissing.length === 0 && bridgeBlockers.length === 0,\n        missing: bridgeMissing,\n        blockers: bridgeBlockers,\n        describe: `withdraw iKAS across ${bridge?.name ?? \"the bridge\"} to KAS on Kaspa L1`\n      },\n      {\n        index: 2,\n        hop: bridgeHop,\n        action: \"await-confirmation\",\n        ready: true,\n        missing: [],\n        blockers: [],\n        describe: \"wait for the withdrawal to land on L1 \\u2014 the crossing above is not reversible by retrying it, and a stranded crossing is a support conversation, not a failed call\"\n      },\n      {\n        index: 3,\n        hop: genesisHop,\n        action: \"sign-and-submit\",\n        ready: true,\n        missing: [],\n        blockers: [],\n        describe: `genesis a grant from the arrived KAS, funded by a single input`\n      }\n    ];\n    return {\n      quote: quote2,\n      route,\n      verdict: verdict(route),\n      steps,\n      custody: \"none\",\n      executable: steps.every((s) => s.ready),\n      blockers: bridgeBlockers\n    };\n  }\n  function missingFrom(plan) {\n    const out = [];\n    for (const s of plan.steps) for (const m of s.missing) if (!out.includes(m)) out.push(m);\n    return out;\n  }\n  return __toCommonJS(router_browser_entry_exports);\n})();\n";
/* Loaded once, and a failure is kept rather than thrown: a module that throws
   while loading is a host error page, and the page reads that as "no answer"
   with nothing to say why. This way every call explains itself. */
let ROUTES = null, ROUTER = null, INIT_ERR = null;
try {
  ROUTES = ROUTES_INLINE || JSON.parse(fs.readFileSync(new URL("./_routes.json", import.meta.url), "utf8"));
  const ctx = {};
  vm.runInNewContext((ROUTER_INLINE || fs.readFileSync(new URL("./_router.js", import.meta.url), "utf8")) + ";this.R=WardaRouter;", ctx);
  ROUTER = ctx.R;
} catch (e) { INIT_ERR = e; }

function pair(chain, token) {
  const src = ROUTES.networks.mainnet.sources.find((s) => s.chain === chain);
  if (!src || src.routes.indexOf("changenow") < 0) return null;
  const p = (src.changenow || {})[token];
  return p ? { chain: src.chain, chainId: src.chainId, token, currency: p.currency, network: p.network } : null;
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}
function fail(res, status, error, message) { send(res, status, { ok: false, error, message }); }

async function cn(pathq, init) {
  const r = await fetch(BASE + pathq, {
    ...init,
    headers: { "x-changenow-api-key": KEY, "content-type": "application/json", ...(init && init.headers) },
    signal: AbortSignal.timeout(15000),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok) {
    const err = new Error((j && (j.message || j.error)) || "ChangeNOW answered " + r.status);
    err.status = r.status; err.code = j && j.error;
    throw err;
  }
  return j;
}

/* Amounts are decimal strings: a number that went through a double on its
   way to a swap is a number nobody chose. */
function amountOf(v) {
  const s = String(v == null ? "" : v).trim();
  return /^\d{1,9}(\.\d{1,6})?$/.test(s) && Number(s) > 0 ? s : null;
}

function kaspaMainnet(addr) {
  try {
    const d = ROUTER.decodeAddress(String(addr || "").trim());
    return d.prefix === "kaspa" ? null : "that is a " + d.prefix + " address; this swap delivers mainnet KAS, to a kaspa: address";
  } catch (e) {
    return "the Kaspa address does not check out: " + e.message;
  }
}

async function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((n, x) => n + x.length, 0) > 4096) throw new Error("body too large"); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const STATUS_SAY = {
  new: "created — waiting for your deposit",
  waiting: "waiting for your deposit",
  confirming: "deposit seen, waiting for confirmations",
  exchanging: "swapping",
  sending: "sending KAS to your address",
  finished: "done — KAS sent",
  failed: "failed",
  refunded: "refunded to your refund address",
  verifying: "held for verification by ChangeNOW",
};

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const op = url.searchParams.get("op");
  if (INIT_ERR) return fail(res, 500, "init", "The swap function could not load its route table: " + INIT_ERR.message);
  if (!KEY) return fail(res, 503, "not_configured", "The swap service is not configured on this site yet (no ChangeNOW API key). Nothing was sent anywhere.");

  try {
    if (req.method === "GET" && op === "quote") {
      const p = pair(url.searchParams.get("chain"), url.searchParams.get("token"));
      if (!p) return fail(res, 400, "pair", "That chain and token are not a route this console offers.");
      const amount = amountOf(url.searchParams.get("amount"));
      const q = "fromCurrency=" + p.currency + "&fromNetwork=" + p.network + "&toCurrency=kas&toNetwork=kas&flow=standard";
      const range = await cn("/exchange/range?" + q);
      let est = null;
      if (amount && Number(amount) >= Number(range.minAmount) && (range.maxAmount == null || Number(amount) <= Number(range.maxAmount))) {
        est = await cn("/exchange/estimated-amount?" + q + "&type=direct&fromAmount=" + amount);
      }
      return send(res, 200, {
        ok: true, pair: p, amount,
        min: range.minAmount, max: range.maxAmount,
        toAmount: est ? est.toAmount : null,
        speed: est ? est.transactionSpeedForecast : null,
        warning: est ? est.warningMessage : null,
        partnerFeePct: FEE,
        flow: "standard",
        says: "ChangeNOW's estimate at its floating rate. The KAS you receive is what it has when your deposit arrives, not this figure.",
      });
    }

    if (req.method === "POST" && op === "create") {
      if (FEE == null) return fail(res, 503, "fee_not_stated", "This site has not stated what it earns on a swap (CHANGENOW_PARTNER_FEE_PCT is not a percentage), so it will not create one. Nothing was sent anywhere.");
      const b = await body(req);
      const p = pair(b.chain, b.token);
      if (!p) return fail(res, 400, "pair", "That chain and token are not a route this console offers.");
      const amount = amountOf(b.amount);
      if (!amount) return fail(res, 400, "amount", "The amount must be a positive number with at most six decimals.");
      const bad = kaspaMainnet(b.address);
      if (bad) return fail(res, 400, "address", bad);
      const refund = String(b.refundAddress || "").trim();
      if (refund && !/^0x[0-9a-fA-F]{40}$/.test(refund)) return fail(res, 400, "refundAddress", "A refund address on an EVM chain is 0x followed by 40 hex characters.");
      const q = "fromCurrency=" + p.currency + "&fromNetwork=" + p.network + "&toCurrency=kas&toNetwork=kas&flow=standard";
      const range = await cn("/exchange/range?" + q);
      if (Number(amount) < Number(range.minAmount)) return fail(res, 400, "amount", "Below ChangeNOW's minimum for this pair, " + range.minAmount + " " + p.token + ".");
      if (range.maxAmount != null && Number(amount) > Number(range.maxAmount)) return fail(res, 400, "amount", "Above ChangeNOW's maximum for this pair, " + range.maxAmount + " " + p.token + ".");
      const x = await cn("/exchange", {
        method: "POST",
        body: JSON.stringify({
          fromCurrency: p.currency, fromNetwork: p.network, toCurrency: "kas", toNetwork: "kas",
          fromAmount: amount, toAmount: "", address: String(b.address).trim(), extraId: "",
          refundAddress: refund, refundExtraId: "", userId: "", payload: "", contactEmail: "",
          flow: "standard", type: "direct", rateId: "",
        }),
      });
      /* The deposit token's contract, from ChangeNOW's own currency list, so
         the page can offer "send from your wallet" without a contract address
         typed into this repository. */
      let tokenContract = null;
      try {
        const list = await cn("/exchange/currencies?active=true&flow=standard");
        const c = (list || []).find((c) => c.ticker === p.currency && c.network === p.network);
        tokenContract = c && c.tokenContract ? c.tokenContract : null;
      } catch (e) { tokenContract = null; }
      return send(res, 200, {
        ok: true, id: x.id, pair: p,
        payinAddress: x.payinAddress, payinExtraId: x.payinExtraId || null,
        payoutAddress: x.payoutAddress, fromAmount: x.fromAmount, toAmount: x.toAmount,
        refundAddress: x.refundAddress || null, tokenContract, partnerFeePct: FEE,
      });
    }

    if (req.method === "GET" && op === "status") {
      const id = url.searchParams.get("id") || "";
      if (!/^[a-z0-9]{14}$/i.test(id)) return fail(res, 400, "id", "An exchange id is 14 letters and digits.");
      const s = await cn("/exchange/by-id?id=" + id);
      return send(res, 200, {
        ok: true, id: s.id, status: s.status, says: STATUS_SAY[s.status] || s.status,
        from: { currency: s.fromCurrency, network: s.fromNetwork, expected: s.expectedAmountFrom, received: s.amountFrom, hash: s.payinHash || null },
        to: { expected: s.expectedAmountTo, sent: s.amountTo, hash: s.payoutHash || null, address: s.payoutAddress },
        payinAddress: s.payinAddress, refundHash: s.refundHash || null, refundAmount: s.refundAmount || null,
        createdAt: s.createdAt, updatedAt: s.updatedAt, depositReceivedAt: s.depositReceivedAt || null,
      });
    }

    return fail(res, 404, "op", "Unknown operation. quote, create or status.");
  } catch (e) {
    return fail(res, e.status && e.status < 500 ? 400 : 502, e.code || "changenow", "ChangeNOW: " + e.message);
  }
};
