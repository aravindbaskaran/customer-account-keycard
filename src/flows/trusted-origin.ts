export function isTrustedAuthenticationUrl(target: string, storeUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  return url.origin === new URL(storeUrl).origin || (url.protocol === "https:" && (url.hostname === "shopify.com" || url.hostname === "accounts.shopify.com"));
}