// Everything the app does with the one pasted token, in order. The token is deleted at the end,
// and also after any failure once we know the token belongs to this Worker's account.

const API = "https://api.cloudflare.com/client/v4";
const BUCKET_ITEM_WRITE = "Workers R2 Storage Bucket Item Write";

export type SetupInput = {
  token: string;
  scriptName: string;
  versionId: string;
  host: string;
  ownerEmail: string;
  bucket: string;
  fetch: typeof globalThis.fetch;
};

export type SetupOutcome =
  | { ok: true; accountId: string; encryptionKey: string }
  | {
      ok: false;
      failedStep: string;
      reason: string;
      tokenDeleted: boolean;
      pasted: string;
      // Set when the key was already stored, so the owner still sees it once.
      encryptionKey?: string;
    };

type CloudflareError = { code: number; message: string; error_chain?: CloudflareError[] };

class StepFailed extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

function describeError(error: CloudflareError): string {
  const chain = error.error_chain?.map(describeError).join("; ");
  return `${error.code} ${error.message}${chain ? ` (${chain})` : ""}`;
}

// The token's shape, safe to show: its length and the kinds of characters in it, never the value.
function describePasted(token: string): string {
  const kinds = [];
  if (/[a-z]/i.test(token)) kinds.push("letters");
  if (/[0-9]/.test(token)) kinds.push("digits");
  const other = [...new Set(token.replace(/[a-z0-9]/gi, ""))];
  if (other.length) kinds.push(`other: ${other.join(" ")}`);
  return `${token.length} characters: ${kinds.join(", ")}`;
}

function client(input: SetupInput) {
  // Called unbound: the runtime's fetch throws "Illegal invocation" when called as input.fetch().
  const { fetch } = input;
  return async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: { success?: boolean; result?: T; errors?: CloudflareError[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StepFailed(`HTTP ${response.status}, not JSON: ${text.slice(0, 200)}`, response.status);
    }
    if (!response.ok || !parsed.success) {
      const errors = parsed.errors?.map(describeError).join("; ");
      throw new StepFailed(errors || `HTTP ${response.status}`, response.status);
    }
    return parsed.result as T;
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newEncryptionKey(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
}

export async function runSetup(pastedInput: SetupInput): Promise<SetupOutcome> {
  // Tokens never contain spaces; copying can add them, or a "Bearer " in front.
  const input = { ...pastedInput, token: pastedInput.token.replace(/\s+/g, "").replace(/^Bearer/i, "") };
  const call = client(input);
  let step = "find this Worker's account";
  let accountId: string | undefined;
  let tokenId: string | undefined;
  let tokenDeleted = false;
  let storedKey: string | undefined;

  try {
    // The running version id exists only in the account this Worker is deployed to.
    const accounts = await call<{ id: string }[]>("GET", "/accounts");
    for (const account of accounts) {
      const versions = await call<{ items: { id: string }[] }>(
        "GET",
        `/accounts/${account.id}/workers/scripts/${input.scriptName}/versions`,
      ).catch((error) => {
        // Not found means this Worker is not in that account; anything else is a real failure.
        if (error instanceof StepFailed && error.status === 404) return { items: [] };
        throw error;
      });
      if (versions.items.some((v) => v.id === input.versionId)) accountId = account.id;
    }
    if (!accountId) throw new StepFailed("this token belongs to another Cloudflare account");

    step = "read the pasted token's id";
    tokenId = (await call<{ id: string }>("GET", `/accounts/${accountId}/tokens/verify`)).id;

    step = "create the R2 key";
    const groups = await call<{ id: string; name: string }[]>("GET", `/accounts/${accountId}/tokens/permission_groups`);
    const bucketItemWrite = groups.find((g) => g.name === BUCKET_ITEM_WRITE);
    if (!bucketItemWrite) throw new StepFailed(`no permission group named "${BUCKET_ITEM_WRITE}"`);
    const r2Token = await call<{ id: string; value: string }>("POST", `/accounts/${accountId}/tokens`, {
      name: `${input.scriptName} files`,
      policies: [
        {
          effect: "allow",
          permission_groups: [{ id: bucketItemWrite.id }],
          resources: { [`com.cloudflare.edge.r2.bucket.${accountId}_default_${input.bucket}`]: "*" },
        },
      ],
    });

    step = "create the Access app";
    const app = await call<{ aud: string }>("POST", `/accounts/${accountId}/access/apps`, {
      name: input.scriptName,
      type: "self_hosted",
      domain: input.host,
      policies: [{ name: "Owner only", decision: "allow", include: [{ email: { email: input.ownerEmail } }] }],
    });

    step = "store the secrets";
    const encryptionKey = newEncryptionKey();
    const secrets: Record<string, string> = {
      ACCOUNT_ID: accountId,
      R2_ACCESS_KEY_ID: r2Token.id,
      R2_SECRET_ACCESS_KEY: await sha256Hex(r2Token.value),
      ACCESS_AUD: app.aud,
      ENCRYPTION_KEY: encryptionKey,
      SETUP_DONE: "1",
    };
    await call("PATCH", `/accounts/${accountId}/workers/scripts/${input.scriptName}/secrets-bulk`, {
      secrets: Object.fromEntries(Object.entries(secrets).map(([name, text]) => [name, { type: "secret_text", text }])),
    });
    storedKey = encryptionKey;

    step = "delete the pasted token";
    await call("DELETE", `/accounts/${accountId}/tokens/${tokenId}`);
    tokenDeleted = true;

    step = "confirm the pasted token no longer works";
    const stillWorks = await call("GET", `/accounts/${accountId}/tokens/verify`).then(
      () => true,
      () => false,
    );
    if (stillWorks) throw new StepFailed("Cloudflare still accepts the token after deleting it");
    return { ok: true, accountId, encryptionKey };
  } catch (error) {
    const reason = error instanceof StepFailed ? error.message : String(error);
    const deleteAttempted = step === "delete the pasted token" || step === "confirm the pasted token no longer works";
    if (accountId && tokenId && !deleteAttempted) {
      tokenDeleted = await call("DELETE", `/accounts/${accountId}/tokens/${tokenId}`).then(
        () => true,
        () => false,
      );
    }
    return {
      ok: false,
      failedStep: step,
      reason,
      tokenDeleted,
      pasted: describePasted(input.token),
      encryptionKey: storedKey,
    };
  }
}
