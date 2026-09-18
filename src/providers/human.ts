import { createInterface } from "node:readline/promises";
import type { ChallengeProvider, ChallengeRequest } from "../core/types.js";

export function humanProvider(): ChallengeProvider {
  return {
    name: "human",
    kinds: ["email-code", "human"],
    async answer(req: ChallengeRequest) {
      if (!process.stdin.isTTY) throw new Error("human provider needs an interactive terminal");
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const timer = setTimeout(() => rl.close(), req.timeoutMs);
        const answer = await rl.question(`[keycard] ${req.hint} for ${req.shopper.email}: `);
        clearTimeout(timer);
        const trimmed = answer.trim();
        if (!trimmed) throw new Error("empty answer from human");
        return trimmed;
      } finally {
        rl.close();
      }
    },
  };
}
