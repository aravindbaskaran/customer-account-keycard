import type { ChallengeProvider, KeycardConfig } from "../core/types.js";
import { resolveMaybeSecret } from "../core/secrets.js";
import { testmailProvider } from "./testmail.js";
import { humanProvider } from "./human.js";

export async function buildProviders(config: KeycardConfig): Promise<Record<string, ChallengeProvider>> {
  const out: Record<string, ChallengeProvider> = { human: humanProvider() };
  if (config.providers.testmail) {
    const apiKey = await resolveMaybeSecret(config.providers.testmail.apiKey);
    const namespace = await resolveMaybeSecret(config.providers.testmail.namespace, { redact: false });
    if (!apiKey || !namespace) throw new Error("testmail provider configured but apiKey/namespace resolved empty");
    out.testmail = testmailProvider({ apiKey, namespace });
  }
  return out;
}
