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
  parseRecipients,
  toSompi,
  wardaPost,
  type WardaAssumption,
  type WardaReadFrom,
} from "./warda-core";

type Amount = { sompi: string; kas: string };

type AuthorityResult = {
  address: string;
  wouldBeRefused: boolean;
  refusal: string | null;
  requested: Amount;
  payTo: string;
  maxNextSpend: Amount;
  boundBy: string;
  found: boolean;
};

type CheckAuthorityResult =
  | {
      success: true;
      /**
       * True when nothing the covenant checks would refuse this payment. It is
       * not a permission: the covenant decides, on chain, and it decides the
       * same way whether or not this was asked.
       */
      allowed: boolean;
      refusal: string | null;
      boundBy: string;
      maxNextSpendKas: string;
      maxNextSpendSompi: string;
      requestedKas: string;
      requestedSompi: string;
      grantAddress: string;
      grantFound: boolean;
      readFrom: WardaReadFrom;
      assumptions: WardaAssumption[];
      enforcement: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type CheckAuthorityCoreInput = {
  manifest: string;
  recipients: string;
  amount: string;
  amountUnit?: string;
  payTo: string;
  network?: string;
};

export type CheckAuthorityInput = StepInput &
  CheckAuthorityCoreInput & {
    integrationId?: string;
  };

function invalid(error: string): CheckAuthorityResult {
  return { success: false, error, errorClass: ExecutionErrorType.USER };
}

async function stepHandler(
  input: CheckAuthorityCoreInput,
  credentials: WardaCredentials
): Promise<CheckAuthorityResult> {
  const manifest = parseManifest(input.manifest);
  if ("error" in manifest) {
    return invalid(manifest.error);
  }

  const recipients = parseRecipients(input.recipients);
  if (recipients.length === 0) {
    return invalid(
      "The grant's payee list is required. A grant commits to the Merkle root of its payees, and a root cannot produce a membership proof — so whether this payee is allowed cannot be answered from the manifest alone."
    );
  }

  const payTo = input.payTo?.trim();
  if (!payTo) {
    return invalid("A payee address is required.");
  }

  const amount = toSompi(input.amount, input.amountUnit);
  if ("error" in amount) {
    return invalid(amount.error);
  }

  const response = await wardaPost<AuthorityResult>(
    "/v1/authority",
    {
      manifest: manifest.manifest,
      recipients,
      ...(input.network ? { network: input.network } : {}),
      payment: { amountSompi: amount.sompi, payTo },
    },
    credentials
  );

  if (!response.success) {
    return response;
  }

  const { result, readFrom, assumptions, enforcement } = response.data;
  return {
    success: true,
    allowed: !result.wouldBeRefused,
    refusal: result.refusal,
    boundBy: result.boundBy,
    maxNextSpendKas: result.maxNextSpend.kas,
    maxNextSpendSompi: result.maxNextSpend.sompi,
    requestedKas: result.requested.kas,
    requestedSompi: result.requested.sompi,
    grantAddress: result.address,
    grantFound: result.found,
    readFrom,
    assumptions,
    enforcement,
  };
}

export async function checkAuthorityStep(
  input: CheckAuthorityInput
): Promise<CheckAuthorityResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "warda", actionName: "check-authority" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "warda";
