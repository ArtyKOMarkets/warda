const TRAILING_SLASH_RE = /\/+$/;

/**
 * Reaches the verification service's own health route, which reports the Kaspa
 * node behind it. A service answering at all is not enough: it refuses to serve
 * from a node that would produce a plausible wrong answer, and that refusal is
 * a 503 the connection test should surface now rather than at workflow runtime.
 */
export async function testWarda(
  credentials: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const raw = credentials.WARDA_VERIFY_URL?.trim();
  if (!raw) {
    return {
      success: false,
      error:
        "A Warda verification service URL is required. There is no shared instance: the service reads a Kaspa node, and which node answered is part of every result.",
    };
  }

  try {
    const base = raw.replace(TRAILING_SLASH_RE, "");
    const response = await fetch(`${base}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (response.status === 503) {
      const body = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      return {
        success: false,
        error: `The service is reachable but its Kaspa node is not usable: ${body?.message ?? "no detail given"}`,
      };
    }

    if (!response.ok) {
      return {
        success: false,
        error: `Verification service returned HTTP ${response.status}. Check the URL.`,
      };
    }

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
