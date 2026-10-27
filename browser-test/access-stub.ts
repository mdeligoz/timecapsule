// Stands in for Cloudflare Access during browser tests: serves the signing keys the Worker checks against,
// and hands the tests a login token for the owner. Run by Playwright before the Worker starts.
import { createServer } from "node:http";
import { makeSigner } from "../test/token.ts";

const signer = await makeSigner();

createServer(async (request, response) => {
  if (request.url === "/cdn-cgi/access/certs") {
    response.end(signer.jwks);
  } else if (request.url === "/token") {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    response.end(
      await signer.sign({ aud: ["browser-test"], iss: "http://127.0.0.1:8788", email: "owner@example.com", exp }),
    );
  } else {
    response.statusCode = 404;
    response.end();
  }
}).listen(8788, "127.0.0.1");
