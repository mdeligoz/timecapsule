import { exportList, exportPage } from "./export";
import { forbidden, notFound, page } from "./html";
import { deleteLetter, deletePage, editPage, letterFile, letterPage } from "./letter";
import { lettersPage } from "./letters";
import { AccessKeys, loginEmail } from "./login";
import { sendStatus } from "./notify";
import { fromOtherSite, otherSite } from "./origin";
import { type SendEnv, sendDue } from "./send";
import { saveSettings, settingsPage } from "./settings";
import { type SetupEnv, setup } from "./setup";
import { addUpload, clearUploads, removeUpload, saveLetter, updateLetter, writePage } from "./write";

export interface Env {
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  OWNER_EMAIL: string;
  LETTER_KEY: string;
  DB: D1Database;
  FILES: R2Bucket;
}

export async function handle(request: Request, env: Env, keys: AccessKeys, nowSeconds: number): Promise<Response> {
  const token = request.headers.get("cf-access-jwt-assertion");
  const email = await loginEmail(token, keys, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD, nowSeconds);
  if (email === null || !env.OWNER_EMAIL || email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase()) {
    return forbidden();
  }
  if (fromOtherSite(request)) return otherSite();
  const url = new URL(request.url);
  const now = nowSeconds * 1000;
  if (request.method === "GET" && url.pathname === "/") return page(await lettersPage(env, url), { here: "/" });
  if (request.method === "GET" && url.pathname === "/write")
    return page(await writePage(env.DB, now, env.OWNER_EMAIL), { here: "/write" });
  if (request.method === "GET" && url.pathname === "/settings")
    return page(await settingsPage(env.DB, url), { here: "/settings" });
  if (request.method === "POST" && url.pathname === "/settings") return saveSettings(request, env.DB);
  if (request.method === "GET" && url.pathname === "/export") return exportList(env, now);
  const exported = /^\/export\/letters\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && exported) return exportPage(env, Number(exported[1]));
  if (request.method === "POST" && url.pathname === "/letters") return saveLetter(request, env, now);
  if (request.method === "POST" && url.pathname === "/uploads") return addUpload(request, env, url, now);
  const upload = /^\/uploads\/(\d+)$/.exec(url.pathname);
  if (request.method === "DELETE" && upload) return removeUpload(env, Number(upload[1]));
  const letter = /^\/letters\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && letter) return letterPage(env, Number(letter[1]), url, now);
  if (request.method === "PUT" && letter) return updateLetter(request, env, Number(letter[1]), now);
  const action = /^\/letters\/(\d+)\/(edit|delete)$/.exec(url.pathname);
  if (request.method === "GET" && action?.[2] === "edit") return editPage(env, Number(action[1]), now);
  if (request.method === "GET" && action?.[2] === "delete") return deletePage(env, Number(action[1]));
  if (request.method === "POST" && action?.[2] === "delete") return deleteLetter(env, Number(action[1]));
  const file = /^\/letters\/(\d+)\/files\/(\d+)$/.exec(url.pathname);
  if (request.method === "GET" && file) return letterFile(env, Number(file[1]), Number(file[2]));
  return notFound();
}

// Kept for the life of the Worker instance, so the keys are fetched once, not on every request.
let keys: AccessKeys | undefined;

export default {
  async fetch(request: Request, env: SendEnv & SetupEnv): Promise<Response> {
    if (env.SETUP_DONE !== "1") return setup(request, env, (url, init) => fetch(url, init), Date.now());
    keys ??= new AccessKeys(env.ACCESS_TEAM_DOMAIN, (url) => fetch(url));
    return handle(request, env, keys, Math.floor(Date.now() / 1000));
  },
  async scheduled(_controller: ScheduledController, env: SendEnv): Promise<void> {
    const now = Date.now();
    await sendDue(env, (url, init) => fetch(url, init), now);
    await sendStatus(env, (url, init) => fetch(url, init), now);
    await clearUploads(env, now);
  },
} satisfies ExportedHandler<SendEnv & SetupEnv>;
