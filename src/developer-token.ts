/**
 * Google retired developer tokens on 2026-09-09. The API ignores the
 * `developer-token` header now and has said a future major version will reject
 * it, so the hosted server no longer carries one.
 *
 * google-ads-api 23 still builds that header unconditionally, from the client
 * options, and an unset token becomes `developer-token: undefined` on every
 * call. This drops the header whenever the token is unset and leaves it alone
 * when one is configured, so a laptop .env that still has a token behaves as
 * before.
 *
 * The library does not export the class that owns the header getter, so it is
 * found from a real instance by walking the prototype chain. If a library
 * upgrade moves or renames the getter, this throws at startup rather than
 * quietly sending the header again.
 */
import { GoogleAdsApi } from "google-ads-api";

let installed = false;

export function omitUnsetDeveloperToken(): void {
  if (installed) return;
  const probe = new GoogleAdsApi({ client_id: "-", client_secret: "-", developer_token: "" })
    .Customer({ customer_id: "0", refresh_token: "-" });
  let proto: object | null = Object.getPrototypeOf(probe);
  let desc: PropertyDescriptor | undefined;
  while (proto && !(desc = Object.getOwnPropertyDescriptor(proto, "callHeaders"))) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto || !desc?.get) {
    throw new Error("google-ads-api no longer has a callHeaders getter; re-check developer-token.ts against the new version");
  }
  const original = desc.get;
  Object.defineProperty(proto, "callHeaders", {
    ...desc,
    get(this: unknown) {
      const headers = { ...(original.call(this) as Record<string, unknown>) };
      if (!headers["developer-token"]) delete headers["developer-token"];
      return headers;
    },
  });
  installed = true;
}
