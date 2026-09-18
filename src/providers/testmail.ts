import type { ChallengeBinding, ChallengeProvider, ChallengeRequest } from "../core/types.js";

export interface TestmailEmail {
  subject?: string;
  text?: string;
  html?: string;
  timestamp?: number;
  tag?: string;
}

export function parseCode(mail: TestmailEmail, subject: RegExp, code: RegExp, expectedTag?: string): string | null {
  if (expectedTag && mail.tag !== expectedTag) return null;
  if (!subject.test(mail.subject ?? "")) return null;
  const m = `${mail.subject ?? ""} ${mail.text ?? ""}`.match(code);
  return m ? m[0] : null;
}

export function testmailProvider(cfg: { apiKey: string; namespace: string; baseUrl?: string; pollMs?: number }): ChallengeProvider {
  const baseUrl = cfg.baseUrl ?? "https://api.testmail.app/api/json";
  const pollMs = cfg.pollMs ?? 2000;
  return {
    name: "testmail",
    kinds: ["email-code"],
    async answer(req: ChallengeRequest, binding: ChallengeBinding) {
      const o = binding.options ?? {};
      if (!o.tag) throw new Error(`testmail binding for ${req.shopper.email} has no tag`);
      const subject = new RegExp(o.subjectPattern ?? "is your code", "i");
      const code = new RegExp(o.codePattern ?? "\\d{6}");
      const params = new URLSearchParams({
        apikey: cfg.apiKey,
        namespace: cfg.namespace,
        tag: o.tag,
        livequery: "false",
        timestamp_from: String(req.since),
        limit: "10",
      });
      const url = `${baseUrl}?${params}`;
      const deadline = Date.now() + req.timeoutMs;
      let lastErr = "";
      while (Date.now() < deadline) {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 8000);
        try {
          const res = await fetch(url, { signal: ac.signal });
          const body = (await res.json()) as { result?: string; message?: string; emails?: TestmailEmail[] };
          if (body.result === "fail") throw new Error(body.message ?? "testmail api error");
          for (const mail of body.emails ?? []) {
            const found = parseCode(mail, subject, code, o.tag);
            if (found) return found;
          }
        } catch (err) {
          lastErr = (err as Error).message;
        } finally {
          clearTimeout(t);
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      throw new Error(`no code for ${req.shopper.email} within ${req.timeoutMs}ms${lastErr ? ` (last error: ${lastErr})` : ""}`);
    },
  };
}
