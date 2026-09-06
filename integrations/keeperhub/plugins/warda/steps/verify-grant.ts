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
  wardaPost,
  type WardaAssumption,
  type WardaReadFrom,
} from "./warda-core";

type Amount = { sompi: string; kas: string };
type Finding = { level: "ok" | "warn" | "error"; text: string };

type VerifyResult = {
  address: string;
  found: boolean;
  value: Amount | null;
  covenantId: string | null;
  remaining: Amount;
  epochRemaining: Amount;
  maxNextSpend: Amount;
  boundBy: string;
  reclaimable: boolean;
  agrees: boolean;
  findings: Finding[];
};

type VerifyGrantResult =
  | {
      success: true;
      /** No error findings: the chain agrees with everything the manifest claimed. */
      agrees: boolean;
      found: boolean;
      grantAddress: string;
      holdsKas: string | null;
      remainingKas: string;
      epochRemainingKas: string;
      maxNextSpendKas: string;
      boundBy: string;
      covenantId: string | null;
      reclaimable: boolean;
      findings: Finding[];
      problems: string[];
      readFrom: WardaReadFrom;
      assumptions: WardaAssumption[];
      enforcement: string;
    }
  | { success: false; error: string; errorClass?: ExecutionErrorType };

export type VerifyGrantCoreInput = {
  manifest: string;
  recipients?: string;
  network?: string;
};

export type VerifyGrantInput = StepInput &
  VerifyGrantCoreInput & {
    integrationId?: string;
  };

async function stepHandler(
  input: VerifyGrantCoreInput,
  credentials: WardaCredentials
): Promise<VerifyGrantResult> {
  const manifest = parseManifest(input.manifest);
  if ("error" in manifest) {
    return {
      success: false,
      error: manifest.error,
      errorClass: ExecutionErrorType.USER,
    };
  }

  const recipients = parseRecipients(input.recipients);
  const response = await wardaPost<VerifyResult>(
    "/v1/verify",
    {
      manifest: manifest.manifest,
      ...(recipients.length > 0 ? { recipients } : {}),
      ...(input.network ? { network: input.network } : {}),
    },
    credentials
  );

  if (!response.success) {
    return response;
  }

  const { result, readFrom, assumptions, enforcement } = response.data;
  const problems: string[] = [];
  for (const finding of result.findings) {
    if (finding.level === "error") {
      problems.push(finding.text);
    }
  }

  return {
    success: true,
    agrees: result.agrees,
    found: result.found,
    grantAddress: result.address,
    holdsKas: result.value ? result.value.kas : null,
    remainingKas: result.remaining.kas,
    epochRemainingKas: result.epochRemaining.kas,
    maxNextSpendKas: result.maxNextSpend.kas,
    boundBy: result.boundBy,
    covenantId: result.covenantId,
    reclaimable: result.reclaimable,
    findings: result.findings,
    problems,
    readFrom,
    assumptions,
    enforcement,
  };
}

export async function verifyGrantStep(
  input: VerifyGrantInput
): Promise<VerifyGrantResult> {
  "use step";

  const credentials = input.integrationId
    ? await fetchCredentials(input.integrationId, {
        organizationId: input._context?.organizationId ?? null,
      })
    : {};

  return runPluginStep(
    { pluginName: "warda", actionName: "verify-grant" },
    input,
    () => stepHandler(input, credentials)
  );
}

export const _integrationType = "warda";
