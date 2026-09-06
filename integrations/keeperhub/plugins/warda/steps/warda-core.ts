import "server-only";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import { ErrorCategory, logUserError } from "@/lib/logging";
import {
  assertUrlIsPublic,
  safeFetch,
  SsrfBlockedError,
} from "@/lib/safe-fetch";
import { getErrorMessage } from "@/lib/utils";
import type { WardaCredentials } from "../credentials";

/**
 * Shared plumbing for talking to a Warda verification service.
 *
 * Warda is an economic-authority protocol for autonomous agents on Kaspa. An
 * agent holds a GRANT: a covenant-bound coin whose per-payment cap, lifetime
 * budget, epoch allowance and payee allowlist are enforced by the network, not
 * by the process holding the key. The verification service reads a Kaspa node
 * and re-derives what that covenant would decide.
 *
 * Nothing here enforces anything, and no step in this plugin ever will. A
 * workflow that gates on `wouldBeRefused` is choosing not to attempt a payment
 * the chain would reject — saving a fee and a confusing script error. The
 * limit itself holds whether or not anybody asks.
 *
 * The service URL comes from the connection because there is no shared
 * instance and should not be one: the answer depends on which Kaspa node was
 * read, so every response names it, and `readFrom` is surfaced as an output
 * field rather than hidden.
 */

const TRAILING_SLASH_RE = /\/+$/;
const LIST_SPLIT_RE = /[\s,]+/;

/** Which node answered, carried through to the workflow's output. */
export type WardaReadFrom = {
  url: string;
  network: string;
  synced: boolean;
  utxoIndexed: boolean;
  virtualDaaScore: string;
  usable: boolean;
  notes: string[];
};

/** A field the service defaulted because the manifest did not state it. */
export type WardaAssumption = {
  field: string;
  value: string;
  why: string;
};

export type WardaEnvelope<T> = {
  ok: true;
  result: T;
  readFrom: WardaReadFrom;
  assumptions: WardaAssumption[];
  enforcement: string;
};

export type WardaFetchResult<T> =
  | { success: true; data: WardaEnvelope<T> }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

type Resolution = { url: string } | { error: string };

export function resolveService(credentials: WardaCredentials): Resolution {
  const raw = credentials.WARDA_VERIFY_URL?.trim();
  if (!raw) {
    return {
      error:
        "No Warda verification service is configured. Add a Warda connection with the URL of a service you run or trust — there is no shared instance, because the answer depends on which Kaspa node it reads.",
    };
  }
  return { url: raw.replace(TRAILING_SLASH_RE, "") };
}

/**
 * A grant manifest, as JSON text from a config field or an upstream node.
 *
 * Parsed here rather than passed through so a typo is a clear message instead
 * of a 400 from a service the workflow author may not have realised it was
 * talking to.
 */
export function parseManifest(
  raw: string | undefined
): { manifest: unknown } | { error: string } {
  const text = raw?.trim();
  if (!text) {
    return {
      error:
        "A grant manifest is required. It is the JSON the grant was issued with — the same file a principal hands to a counterparty.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `The manifest is not valid JSON: ${getErrorMessage(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "The manifest must be a JSON object." };
  }
  return { manifest: parsed };
}

/**
 * The payee list, one address per line or comma separated.
 *
 * A grant commits to the Merkle ROOT of its payees. A root can confirm a list
 * but cannot produce a membership proof from one, so asking whether a given
 * vendor is allowed needs the members themselves. The service checks them
 * against the root before it answers anything.
 */
export function parseRecipients(raw: string | undefined): string[] {
  const text = raw?.trim();
  if (!text) {
    return [];
  }
  return text
    .split(LIST_SPLIT_RE)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

type ServiceError = {
  error?: string;
  field?: string | null;
  message?: string;
};

/** Turn the service's own error shape into something a workflow author can act on. */
function describeFailure(
  status: number,
  body: ServiceError | null
): { error: string; errorClass: ExecutionErrorType } {
  const detail = body?.message ?? `HTTP ${status}`;

  if (status === 503) {
    return {
      error: `The verification service will not answer from its Kaspa node: ${detail}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
  if (body?.field) {
    return {
      error: `${body.field}: ${detail}`,
      errorClass: ExecutionErrorType.USER,
    };
  }
  return {
    error: detail,
    errorClass:
      status >= 500 ? ExecutionErrorType.EXTERNAL : ExecutionErrorType.USER,
  };
}

/**
 * POST to the verification service and normalise the outcome.
 *
 * The service URL is supplied by the connection, so it is validated as a
 * public destination before any request leaves — `assertUrlIsPublic` ignores
 * shadow mode, which `safeFetch` alone does not. Mirrors
 * plugins/blockscout/steps/blockscout-core.ts.
 */
export async function wardaPost<T>(
  path: string,
  body: Record<string, unknown>,
  credentials: WardaCredentials
): Promise<WardaFetchResult<T>> {
  const resolved = resolveService(credentials);
  if ("error" in resolved) {
    return {
      success: false,
      error: resolved.error,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const url = `${resolved.url}${path}`;

  try {
    await assertUrlIsPublic(url);

    const response = await safeFetch(url, {
      plugin: "warda",
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const failure = (await response.json().catch(() => null)) as ServiceError | null;
      return { success: false, ...describeFailure(response.status, failure) };
    }

    const data = (await response.json()) as WardaEnvelope<T>;
    return { success: true, data };
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      logUserError(
        ErrorCategory.VALIDATION,
        "[Warda] Blocked SSRF target",
        error.message,
        { plugin_name: "warda" }
      );
      return {
        success: false,
        error: `The Warda service URL is not allowed: ${error.message}`,
        errorClass: ExecutionErrorType.USER,
      };
    }
    return {
      success: false,
      error: `Failed to reach the Warda verification service: ${getErrorMessage(error)}`,
      errorClass: ExecutionErrorType.EXTERNAL,
    };
  }
}

const DECIMAL_RE = /^\d+(\.\d+)?$/;
const SOMPI_DECIMALS = 8;

/**
 * A KAS or sompi amount as an integer string of sompi.
 *
 * Done with string arithmetic rather than by multiplying a float. Kaspa has
 * eight decimal places and this protocol's amounts are u64: a budget expressed
 * as a JavaScript number can be rounded before anything has looked at it, and
 * a rounded amount is indistinguishable from an amount.
 */
export function toSompi(
  amount: string | undefined,
  unit: string | undefined
): { sompi: string } | { error: string } {
  const text = amount?.trim();
  if (!text) {
    return { error: "An amount is required." };
  }

  if (unit === "sompi") {
    if (!/^\d+$/.test(text)) {
      return { error: `Sompi must be a whole number, got "${text}".` };
    }
    return { sompi: text };
  }

  if (!DECIMAL_RE.test(text)) {
    return { error: `"${text}" is not a KAS amount.` };
  }
  const [whole = "0", fraction = ""] = text.split(".");
  if (fraction.length > SOMPI_DECIMALS) {
    return {
      error: `KAS has ${SOMPI_DECIMALS} decimal places, got ${fraction.length}.`,
    };
  }
  const padded = fraction.padEnd(SOMPI_DECIMALS, "0");
  const scale = BigInt("1" + "0".repeat(SOMPI_DECIMALS));
  const sompi = BigInt(whole) * scale + BigInt(padded || "0");
  return { sompi: sompi.toString() };
}
