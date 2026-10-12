/**
 * Developer tokens were retired on 2026-09-09. With none configured the server
 * must send no `developer-token` header at all (not "undefined", not ""), and a
 * configured one must still be sent, so a laptop .env keeps working.
 * Run: npm test
 */
import assert from "node:assert/strict";

delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
process.env.GOOGLE_ADS_CLIENT_ID ||= "test";
process.env.GOOGLE_ADS_CLIENT_SECRET ||= "test";
process.env.GOOGLE_ADS_REFRESH_TOKEN ||= "test";
process.env.GOOGLE_ADS_CUSTOMER_ID ||= "1111111111";
process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ||= "1234567890";

// Importing index proves startup no longer requires the token.
await import("../dist/index.js");
const { omitUnsetDeveloperToken } = await import("../dist/developer-token.js");
const { GoogleAdsApi } = await import("google-ads-api");
omitUnsetDeveloperToken(); // idempotent

const headers = (developer_token) => new GoogleAdsApi({ client_id: "a", client_secret: "b", developer_token })
  .Customer({ customer_id: "1", refresh_token: "r", login_customer_id: "1234567890" }).callHeaders;

for (const unset of [undefined, ""]) {
  const h = headers(unset);
  assert.equal("developer-token" in h, false, `no header when the token is ${JSON.stringify(unset)}`);
  assert.equal(h["login-customer-id"], "1234567890", "other headers are untouched");
}
assert.equal(headers("tok")["developer-token"], "tok", "a configured token is still sent");

console.log("developer-token: PASS");
