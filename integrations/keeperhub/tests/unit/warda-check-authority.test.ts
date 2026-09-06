import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/workflow/executor/step-handler", () => ({
  runPluginStep: (
    _options: unknown,
    _input: unknown,
    fn: (input: unknown) => unknown
  ) => fn(_input),
  withStepLogging: (_input: unknown, fn: () => unknown) => fn(),
}));

vi.mock("@/lib/logging", () => ({
  ErrorCategory: {
    VALIDATION: "validation",
    NETWORK_RPC: "network_rpc",
    EXTERNAL_SERVICE: "external_service",
  },
  logUserError: vi.fn(),
}));

const safeFetch = vi.fn();
const assertUrlIsPublic = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/safe-fetch", () => ({
  safeFetch: (...args: unknown[]) => safeFetch(...args),
  assertUrlIsPublic: (...args: unknown[]) => assertUrlIsPublic(...args),
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

const fetchCredentials = vi.fn();
vi.mock("@/lib/credential-fetcher", () => ({
  fetchCredentials: (...args: unknown[]) => fetchCredentials(...args),
}));

import { checkAuthorityStep } from "@/plugins/warda/steps/check-authority";
import { toSompi } from "@/plugins/warda/steps/warda-core";

const MANIFEST = JSON.stringify({
  agent: "22".repeat(32),
  principal: "21".repeat(32),
  budget: 500000000,
  max_per_spend: 30000000,
});

const PAYEE = "kaspatest:qzlws9lm7uyt0tftzffshnyeu2zcqk4kf7hw5ghk6v0zh093vnkljcy2fl0fh";

function envelope(result: Record<string, unknown>) {
  return {
    ok: true,
    result,
    readFrom: {
      url: "ws://127.0.0.1:18210",
      network: "testnet-10",
      synced: true,
      utxoIndexed: true,
      virtualDaaScore: "563428316",
      usable: true,
      notes: [],
    },
    assumptions: [],
    enforcement: "Advisory. The covenant enforces, on chain.",
  };
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function fail(status: number, body: unknown) {
  return { ok: false, status, statusText: "", json: () => Promise.resolve(body) };
}

const base = {
  manifest: MANIFEST,
  recipients: PAYEE,
  amount: "0.1",
  amountUnit: "kas",
  payTo: PAYEE,
  integrationId: "int_1",
};

describe("warda/check-authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assertUrlIsPublic.mockResolvedValue(undefined);
    fetchCredentials.mockResolvedValue({
      WARDA_VERIFY_URL: "https://verify.example.com",
    });
  });

  it("says what is missing when no service is configured", async () => {
    fetchCredentials.mockResolvedValue({});
    const result = await checkAuthorityStep(base);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/no shared instance/i);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("will not answer from a Merkle root alone, and explains why", async () => {
    const result = await checkAuthorityStep({ ...base, recipients: "  " });
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/membership proof/);
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it("reports a refusal as not allowed, with the covenant's own sentence", async () => {
    safeFetch.mockResolvedValue(
      ok(
        envelope({
          address: "kaspatest:pryg",
          wouldBeRefused: true,
          refusal:
            "this invoice is 30000001 sompi and the grant's per-payment cap is 30000000.",
          requested: { sompi: "30000001", kas: "0.30000001" },
          payTo: PAYEE,
          maxNextSpend: { sompi: "30000000", kas: "0.3" },
          boundBy: "maxPerSpend",
          found: true,
        })
      )
    );

    const result = await checkAuthorityStep({ ...base, amount: "0.30000001" });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.allowed).toBe(false);
    expect(result.refusal).toMatch(/per-payment cap/);
    expect(result.boundBy).toBe("maxPerSpend");
    expect(result.readFrom.url).toBe("ws://127.0.0.1:18210");
  });

  it("sends the amount in sompi, converted without a float", async () => {
    safeFetch.mockResolvedValue(
      ok(
        envelope({
          address: "kaspatest:pryg",
          wouldBeRefused: false,
          refusal: null,
          requested: { sompi: "30000001", kas: "0.30000001" },
          payTo: PAYEE,
          maxNextSpend: { sompi: "30000000", kas: "0.3" },
          boundBy: "maxPerSpend",
          found: true,
        })
      )
    );

    await checkAuthorityStep({ ...base, amount: "0.30000001" });
    const body = JSON.parse(safeFetch.mock.calls[0][1].body as string);
    expect(body.payment.amountSompi).toBe("30000001");
    expect(body.recipients).toEqual([PAYEE]);
  });

  it("passes a service validation error through with its field", async () => {
    safeFetch.mockResolvedValue(
      fail(400, {
        ok: false,
        error: "invalid_manifest",
        field: "agent",
        message: "agent: expected 64 hex characters",
      })
    );

    const result = await checkAuthorityStep(base);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/^agent: /);
  });

  it("distinguishes an unusable node from a bad request", async () => {
    safeFetch.mockResolvedValue(
      fail(503, {
        ok: false,
        error: "node_unusable",
        message: "the node at ws://bad is NOT SYNCED",
      })
    );

    const result = await checkAuthorityStep(base);
    expect(result.success).toBe(false);
    if (result.success) {
      return;
    }
    expect(result.error).toMatch(/will not answer from its Kaspa node/);
  });

  it("validates the URL as public before any request leaves", async () => {
    safeFetch.mockResolvedValue(
      ok(
        envelope({
          address: "kaspatest:pryg",
          wouldBeRefused: false,
          refusal: null,
          requested: { sompi: "10000000", kas: "0.1" },
          payTo: PAYEE,
          maxNextSpend: { sompi: "30000000", kas: "0.3" },
          boundBy: "maxPerSpend",
          found: true,
        })
      )
    );

    await checkAuthorityStep(base);
    expect(assertUrlIsPublic).toHaveBeenCalledWith(
      "https://verify.example.com/v1/authority"
    );
  });
});

describe("warda toSompi", () => {
  it("converts KAS with integer arithmetic", () => {
    expect(toSompi("1", "kas")).toEqual({ sompi: "100000000" });
    expect(toSompi("0.30000001", "kas")).toEqual({ sompi: "30000001" });
    expect(toSompi("0.1", "kas")).toEqual({ sompi: "10000000" });
  });

  it("passes sompi through and refuses a fractional one", () => {
    expect(toSompi("30000001", "sompi")).toEqual({ sompi: "30000001" });
    expect(toSompi("1.5", "sompi")).toHaveProperty("error");
  });

  it("refuses more precision than Kaspa has", () => {
    expect(toSompi("0.123456789", "kas")).toHaveProperty("error");
  });
});
