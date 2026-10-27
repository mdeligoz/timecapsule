import type { Fetcher } from "./send";

// Everything setup does with the one pasted token, in order. Until the settings are stored, a stop removes what this
// try made and deletes the token; a later try also clears anything an earlier one could not remove.

const API = "https://api.cloudflare.com/client/v4";
const BUCKET_ITEM_WRITE = "Workers R2 Storage Bucket Item Write";

export type ProvisionInput = {
  token: string;
  teamDomain: string;
  letterKey: string;
  scriptName: string;
  versionId: string;
  host: string;
  ownerEmail: string;
  fetch: Fetcher;
};

export type ProvisionOutcome =
  | { ok: true; tokenDeleted: boolean }
  | { ok: false; step: string; reason: string; status?: number; otherAccount?: true; tokenDeleted: boolean };

// The running version's bindings; FILES names the bucket the Worker's files are in, as deployed.
type Binding = { name: string; type: string; bucket_name?: string };
type CloudflareError = { code: number; message: string; error_chain?: CloudflareError[] };
type Answer<T> = { result: T; result_info?: { page: number; total_pages: number } };

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

function client(token: string, fetcher: Fetcher) {
  return async function call<T>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
    const response = await fetcher(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: Answer<T> & { success?: boolean; errors?: CloudflareError[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new StepFailed(`HTTP ${response.status}, not JSON: ${text.slice(0, 200)}`, response.status);
    }
    if (!response.ok || !parsed.success) {
      const errors = parsed.errors?.map(describeError).join("; ");
      throw new StepFailed(errors || `HTTP ${response.status}`, response.status);
    }
    return parsed;
  };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Tokens never contain spaces; copying can add them, or a "Bearer " in front.
export function cleanToken(pasted: string): string {
  return pasted.replace(/^\s*Bearer\s+/i, "").replace(/\s+/g, "");
}

export async function provision(input: ProvisionInput): Promise<ProvisionOutcome> {
  const token = cleanToken(input.token);
  // Called unbound, so the runtime's own fetch could be passed straight in: called as input.fetch() it throws
  // "Illegal invocation".
  const call = client(token, input.fetch);
  // Every page of a list; Cloudflare says in result_info how many pages there are.
  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; ; page++) {
      const answer = await call<T[]>("GET", `${path}?page=${page}&per_page=50`);
      items.push(...answer.result);
      if (!answer.result_info || page >= answer.result_info.total_pages) return items;
    }
  }

  const keyName = `${input.scriptName} files`;
  let step = "check the token";
  let accountId: string | undefined;
  let bindings: Binding[] = [];
  let tokenId: string | undefined;
  const made: { keyId?: string; appId?: string } = {};
  // Once the setup-done mark is sent, it may be stored even if its answer is lost, so nothing is removed after that.
  let doneSent = false;
  let stored = false;

  try {
    // The running version exists only in the account this Worker is deployed to.
    const accounts = (await call<{ id: string }[]>("GET", "/accounts")).result;
    for (const account of accounts) {
      const version = await call<{ resources: { bindings: Binding[] } }>(
        "GET",
        `/accounts/${account.id}/workers/scripts/${input.scriptName}/versions/${input.versionId}`,
      ).then(
        (answer) => answer.result,
        (error) => {
          // Not found means this Worker is not in that account; anything else is a real failure.
          if (error instanceof StepFailed && error.status === 404) return null;
          throw error;
        },
      );
      if (version) {
        accountId = account.id;
        bindings = version.resources.bindings;
      }
    }
    if (!accountId) {
      return { ok: false, step, reason: "the token is for another account", otherAccount: true, tokenDeleted: false };
    }
    const at = `/accounts/${accountId}`;
    tokenId = (await call<{ id: string }>("GET", `${at}/tokens/verify`)).result.id;

    step = "remove what an earlier try left behind";
    for (const key of await all<{ id: string; name: string }>(`${at}/tokens`)) {
      if (key.name === keyName) await call("DELETE", `${at}/tokens/${key.id}`);
    }
    for (const app of await all<{ id: string; domain: string }>(`${at}/access/apps`)) {
      if (app.domain === input.host) await call("DELETE", `${at}/access/apps/${app.id}`);
    }

    step = "make the file storage key";
    const bucket = bindings.find((b) => b.name === "FILES" && b.type === "r2_bucket")?.bucket_name;
    if (!bucket) throw new StepFailed("the running version has no file storage bucket");
    const groups = (await call<{ id: string; name: string }[]>("GET", `${at}/tokens/permission_groups`)).result;
    const bucketItemWrite = groups.find((g) => g.name === BUCKET_ITEM_WRITE);
    if (!bucketItemWrite) throw new StepFailed(`no permission group named "${BUCKET_ITEM_WRITE}"`);
    const key = (
      await call<{ id: string; value: string }>("POST", `${at}/tokens`, {
        name: keyName,
        policies: [
          {
            effect: "allow",
            permission_groups: [{ id: bucketItemWrite.id }],
            resources: { [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`]: "*" },
          },
        ],
      })
    ).result;
    made.keyId = key.id;

    step = "set up the Cloudflare login";
    const app = (
      await call<{ id: string; aud: string }>("POST", `${at}/access/apps`, {
        name: input.scriptName,
        type: "self_hosted",
        domain: input.host,
        policies: [{ name: "Owner only", decision: "allow", include: [{ email: { email: input.ownerEmail } }] }],
      })
    ).result;
    made.appId = app.id;

    step = "store the app's settings";
    // The setup-done mark goes last: until it is stored, the setup page stays open for another try.
    const settings: [string, string][] = [
      ["LETTER_KEY", input.letterKey],
      ["ACCESS_TEAM_DOMAIN", input.teamDomain],
      ["ACCESS_AUD", app.aud],
      ["R2_ACCOUNT_ID", accountId],
      ["R2_ACCESS_KEY_ID", key.id],
      ["R2_SECRET_ACCESS_KEY", await sha256Hex(key.value)],
      ["R2_BUCKET", bucket],
      ["SETUP_DONE", "1"],
    ];
    for (const [name, text] of settings) {
      doneSent = name === "SETUP_DONE";
      await call("PUT", `${at}/workers/scripts/${input.scriptName}/secrets`, { name, text, type: "secret_text" });
    }
    stored = true;

    step = "delete the token";
    return { ok: true, tokenDeleted: await deleteToken(call, accountId, tokenId) };
  } catch (error) {
    const reason = error instanceof StepFailed ? error.message : String(error);
    const status = error instanceof StepFailed ? error.status : undefined;
    if (stored) return { ok: true, tokenDeleted: false };
    if (accountId && !doneSent) {
      const at = `/accounts/${accountId}`;
      // Best effort: what cannot be removed now is cleared by the next try.
      if (made.keyId) await call("DELETE", `${at}/tokens/${made.keyId}`).catch(() => undefined);
      if (made.appId) await call("DELETE", `${at}/access/apps/${made.appId}`).catch(() => undefined);
    }
    const tokenDeleted = accountId && tokenId ? await deleteToken(call, accountId, tokenId) : false;
    return { ok: false, step, reason, ...(status === undefined ? {} : { status }), tokenDeleted };
  }
}

// Deleted only counts once Cloudflare refuses the token.
async function deleteToken(call: ReturnType<typeof client>, accountId: string, tokenId: string): Promise<boolean> {
  try {
    await call("DELETE", `/accounts/${accountId}/tokens/${tokenId}`);
  } catch {
    return false;
  }
  return call("GET", `/accounts/${accountId}/tokens/verify`).then(
    () => false,
    () => true,
  );
}
