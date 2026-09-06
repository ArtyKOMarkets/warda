import type { ActionConfigField, IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { WardaIcon } from "./icon";

// Shared across actions. Factories return fresh objects so no field instance is
// aliased between them, matching plugins/blockscout/index.ts.
const manifestField = (): ActionConfigField => ({
  key: "manifest",
  label: "Grant Manifest",
  type: "template-textarea",
  required: true,
  rows: 6,
  placeholder: '{"agent": "...", "budget": 500000000, ...}  or  {{@node1:Fetch.body}}',
  helpTip:
    "The JSON a Warda grant was issued with. It states the agent's key, its budget, per-payment cap, epoch allowance and the root of its payee list. The service derives the grant's address from these fields and checks the chain against them — so a manifest that describes a different grant finds nothing rather than answering wrongly.",
});

const recipientsField = (required: boolean): ActionConfigField => ({
  key: "recipients",
  label: "Payee Allowlist",
  type: "template-textarea",
  required,
  rows: 3,
  placeholder: "kaspatest:qz...\nkaspatest:qr...",
  helpTip:
    "The grant's payees, one per line. A grant commits to the Merkle root of this list at genesis and it cannot be changed afterwards. The root alone cannot prove membership, which is why the list is needed to answer whether a particular payee is allowed. It is checked against the manifest's root before anything else.",
});

const networkField = (): ActionConfigField => ({
  key: "network",
  label: "Network",
  type: "select",
  options: [
    { value: "testnet-10", label: "Kaspa testnet-10" },
    { value: "mainnet", label: "Kaspa mainnet" },
  ],
  defaultValue: "testnet-10",
  helpTip:
    "Which network the grant lives on. Getting this wrong is the quiet failure: a testnet manifest read against a mainnet node derives a perfectly valid address and finds nothing at it.",
});

const readFromOutputs = [
  {
    field: "readFrom",
    description:
      "Which Kaspa node answered, its network, sync state and DAA score. A verifier that will not say whom it asked is asking to be trusted.",
  },
  {
    field: "assumptions",
    description:
      "Fields the service defaulted because the manifest did not state them, with reasons. Several of these are part of the grant's address.",
  },
  {
    field: "enforcement",
    description:
      "A restatement that this decided nothing. The covenant enforces on chain and is the only thing that can.",
  },
];

const wardaPlugin: IntegrationPlugin = {
  type: "warda",
  egress: "user-destination",
  label: "Warda",
  description:
    "Check what an autonomous agent is allowed to spend on Kaspa before a workflow spends it. A Warda grant's per-payment cap, lifetime budget, epoch allowance and payee allowlist are enforced by consensus rather than by the process holding the key.",

  icon: WardaIcon,

  // The verification service is self-hosted: it reads a Kaspa node, and which
  // node answered is part of every result, so there is no shared instance to
  // fall back to.
  requiresCredentials: true,

  formFields: [
    {
      id: "verifyUrl",
      label: "Verification Service URL",
      type: "url",
      placeholder: "https://verify.example.com",
      configKey: "verifyUrl",
      envVar: "WARDA_VERIFY_URL",
      helpText:
        "Base URL of a Warda verification service. It reads a Kaspa node and re-derives what a grant's covenant would decide; it holds no keys and signs nothing.",
      helpLink: {
        text: "Run one",
        url: "https://github.com/ArtyKOMarkets/warda/tree/main/verify",
      },
    },
  ],

  testConfig: {
    getTestFunction: async () => {
      const { testWarda } = await import("./test");
      return testWarda;
    },
  },

  actions: [
    {
      slug: "check-authority",
      label: "Check Spending Authority",
      description:
        "Ask whether a specific payment would be refused by the agent's grant, and which rule would refuse it. Use it to gate a spend before attempting one the chain will reject.",
      category: "Warda",
      stepFunction: "checkAuthorityStep",
      stepImportPath: "check-authority",
      docUrl: "https://wardaprotocol.com",
      outputFields: [
        {
          field: "allowed",
          description:
            "True when nothing the covenant checks would refuse this payment. Not a permission: the covenant decides on chain, and decides the same way whether or not this was asked.",
        },
        {
          field: "refusal",
          description:
            "Why it would be refused, in a sentence, or null. Produced by the same code the Warda payer runs before it builds a transaction.",
        },
        {
          field: "boundBy",
          description:
            "Which limit binds right now: maxPerSpend, epoch, budget or coin.",
        },
        {
          field: "maxNextSpendKas",
          description:
            "The largest single payment this grant could currently make — the tightest of the four limits, including the coin itself.",
        },
        { field: "maxNextSpendSompi", description: "The same figure in sompi." },
        { field: "requestedKas", description: "The payment that was asked about, in KAS." },
        { field: "requestedSompi", description: "The payment that was asked about, in sompi." },
        { field: "grantAddress", description: "The address this grant's current state derives." },
        {
          field: "grantFound",
          description:
            "Whether a coin was found there. False usually means the manifest is stale by a spend, not that the grant is gone.",
        },
        ...readFromOutputs,
        { field: "error", description: "Error message if the check could not be made" },
      ],
      configFields: [
        manifestField(),
        recipientsField(true),
        {
          key: "payTo",
          label: "Pay To",
          type: "template-input",
          required: true,
          placeholder: "kaspatest:qz... or {{@node1:Quote.payTo}}",
          helpTip:
            "The address that would be paid. A grant can only pay a payee it committed to at genesis, and the covenant requires that payee to be a pay-to-public-key address.",
        },
        {
          key: "amount",
          label: "Amount",
          type: "template-input",
          required: true,
          placeholder: "0.25",
          example: "0.25",
          helpTip: "The payment to test against the grant's limits.",
        },
        {
          key: "amountUnit",
          label: "Unit",
          type: "select",
          options: [
            { value: "kas", label: "KAS" },
            { value: "sompi", label: "sompi" },
          ],
          defaultValue: "kas",
          helpTip:
            "Sompi is Kaspa's smallest unit: one KAS is 100,000,000 sompi. Amounts are converted with integer arithmetic, never through a float.",
        },
        networkField(),
      ],
    },
    {
      slug: "verify-grant",
      label: "Verify Grant",
      description:
        "Check a grant manifest against the chain: does a grant on these terms exist, does it hold what the manifest claims, and how much of it is left.",
      category: "Warda",
      stepFunction: "verifyGrantStep",
      stepImportPath: "verify-grant",
      docUrl: "https://wardaprotocol.com",
      outputFields: [
        {
          field: "agrees",
          description:
            "True when the chain agrees with everything the manifest claimed — no error findings.",
        },
        {
          field: "found",
          description: "Whether a coin exists at the address these terms derive.",
        },
        { field: "grantAddress", description: "The address these terms derive." },
        { field: "holdsKas", description: "What the grant actually holds, or null if nothing is there." },
        {
          field: "remainingKas",
          description:
            "Budget less spent and reserved. An accounting figure the coin may not cover — see maxNextSpendKas.",
        },
        { field: "epochRemainingKas", description: "What is left in the current epoch." },
        { field: "maxNextSpendKas", description: "The largest single payment currently possible." },
        { field: "boundBy", description: "Which of the four limits binds." },
        { field: "covenantId", description: "The covenant the coin is bound by, as the node reports it." },
        { field: "reclaimable", description: "Whether the principal's reclaim right has opened." },
        { field: "findings", description: "Every check the service made, each with a level and a sentence." },
        { field: "problems", description: "Just the error-level findings, for gating on." },
        ...readFromOutputs,
        { field: "error", description: "Error message if the grant could not be checked" },
      ],
      configFields: [manifestField(), recipientsField(false), networkField()],
    },
    {
      slug: "locate-grant",
      label: "Locate Moved Grant",
      description:
        "Find where a grant went when a stored manifest has gone stale. A grant's address is a hash of its state, so every payment relocates it.",
      category: "Warda",
      stepFunction: "locateGrantStep",
      stepImportPath: "locate-grant",
      docUrl: "https://wardaprotocol.com",
      outputFields: [
        { field: "found", description: "Whether a candidate state was confirmed on chain." },
        { field: "grantAddress", description: "Where the grant is now, or null." },
        { field: "holdsKas", description: "What it holds there." },
        { field: "spentTotalKas", description: "Its current spent total." },
        { field: "epochIndex", description: "The epoch its current state claims." },
        { field: "candidatesTried", description: "How many possible states were probed." },
        { field: "note", description: "What the outcome means, including what to try when nothing was found." },
        ...readFromOutputs,
        { field: "error", description: "Error message if the search could not be made" },
      ],
      configFields: [
        manifestField(),
        {
          key: "payments",
          label: "Payments Made",
          type: "template-textarea",
          required: true,
          rows: 4,
          placeholder: '[{"valueSompi": "20000000", "blockDaaScore": "563400000"}]',
          helpTip:
            "The payments this grant made since the manifest was written, as JSON. They are what advanced its state, and kaspad keeps no index that recovers them from an address — whoever was paid has them, and so does anyone watching the payee.",
        },
        {
          key: "subsets",
          label: "Try Payment Subsets",
          type: "protocol-bool",
          defaultValue: "false",
          helpTip:
            "Off, the search assumes this grant's payments are the tail of the list. Turn it on when the payee address is shared with another grant, so the payments are interleaved and no suffix describes them. It costs 2^n candidates.",
        },
        networkField(),
      ],
    },
  ],
};

registerIntegration(wardaPlugin);
export default wardaPlugin;
