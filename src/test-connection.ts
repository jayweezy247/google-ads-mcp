import { GoogleAdsApi } from "google-ads-api";
import * as dotenv from "dotenv";
import { resolveEnvPath } from "./env-path";
dotenv.config({ path: resolveEnvPath() });

async function test() {
  const client = new GoogleAdsApi({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
    client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
    developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
  });
  const customer = client.Customer({
    customer_id: process.env.GOOGLE_ADS_CUSTOMER_ID!,
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
    login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!,
  });
  try {
    const res = await customer.query(
      `SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1`
    );
    console.log("\n✅ CONNECTION SUCCESS!\n");
    console.log("Account:", JSON.stringify(res[0]?.customer, null, 2));
  } catch (e) {
    console.error("\n❌ CONNECTION FAILED:\n");
    console.error(e.message || e);
  }
}
test();
