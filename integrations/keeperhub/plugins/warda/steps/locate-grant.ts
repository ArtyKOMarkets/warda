import "server-only";
import { fetchCredentials } from "@/lib/credential-fetcher";
import { ExecutionErrorType } from "@/lib/errors/execution-error-type";
import {
  runPluginStep,
  type StepInput,
} from "@/lib/workflow/executor/step-handler";
import type { WardaCredentials } from "../credentials";
import {
  parseManifest,
  wardaPost,
  type WardaAssumption,
  type WardaReadFrom,
} from "./warda-core";

type Amount = { sompi: string; kas: string };

type LocateResult = {
  found: boolean;
  address?: string;
  value?: Amount;
  state?: {
    spentTotal: Amount;
    reserved: Amount;
    epochIndex: string;
    epochSpent: Amount;
  };
  paymentsApplied?: number;
  candidatesTried: number;
  note: string;
};

type LocateGrantResult =
  | {
      success: true;
      found: boolean;
      grantAddress: string | null;
      holdsKas: string | null;
      spentTotalKas: string | null;
      epochIndex: string | null;
      candidatesTried: number;
      note: string;
      readFrom: WardaReadFrom;
      assumptions: WardaAssumption[];
      enforcement: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

type PaymentInput = {
  valueSompi?: string | number;
  blockDaaScore?: string | number;
  id?: string;
};

export type LocateGrantCoreInput = {
  manifest: string;
  payments: string;
  subsets?: boolean | string;
  network?: string;
};

export type LocateGrantInput = StepInput &
  LocateGrantCoreInput & {
    integrationId?: string;
  };

/** The protocol-bool field arrives as a string when it came from the UI. */
function isTrue(value: boolean | string | undefined): boolean {
  return value === true || value === "true";
}

function invalid(error: string): LocateGrantResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

function parsePayments(raw: string | undefined): PaymentInput[] | { error: string } {
  const text = raw?.trim();
  if (!text) {
    return {
      error:
        "The payments the grant made are required. They are what advanced its state, and no index recovers them from an address — whoever was paid has them.",
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (_error) {
    return { error: "Payments must be a JSON array of { valueSompi, blockDaaScore }." };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "Payments must be a non-empty JSON array." };
  }
  return parsed as PaymentInput[];
}

async function stepHandler(
  input: LocateGrantCoreInput,
  credentials: WardaCredentials
): Promise<LocateGrantResult> {
  const manifest = parseManifest(input.manifest);
  if ("error" in manifest) {
    return invalid(manifest.error);
  }

  const payments = parsePayments(input.payments);
  if ("error" in payments) {
    return invalid(payments.error);
  }

  const response = await wardaPost<LocateResult>(
    "/v1/locate",
    {
      manifest: manifest.manifest,
      payments,
      ...(isTrue(input.subsets) ? { subsets: true } : {}),
      ...(input.network ? { network: input.network } : {}),
    },
    credentials
  );

  if (!response.success) {
    return response;
  }

  const { result, readFrom, assumptions, enforcement } = response.data;
  return {
    success: true,
    found: result.found,
    grantAddress: result.address ?? null,
    holdsKas: result.value?.kas ?? null,
    spentTotalKas: result.state?.spentTotal.kas ?? null,
    epochIndex: result.state?.epochIndex ?? null,
    candidatesTried: result.candidatesTried,
    note: result.note,
    readFrom,
    assumptions,
    enforcement,
  };
}

export async function locateGrantStep(
  input: LocateGrantInput
): Promise<LocateGrantResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "warda", actionName: "locate-grant" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "warda";
