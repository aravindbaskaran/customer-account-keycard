import type { Logger } from "./types.js";

const secrets = new Set<string>();

function scrub(msg: string): string {
  let out = msg;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("[redacted]");
  return out;
}

export function createLogger(level: "debug" | "info" | "silent" = process.env.KEYCARD_LOG === "debug" ? "debug" : process.env.KEYCARD_LOG === "silent" ? "silent" : "info"): Logger {
  const write = (tag: string, msg: string) => process.stderr.write(`[keycard] ${tag} ${scrub(msg)}\n`);
  return {
    info: (m) => level !== "silent" && write("info ", m),
    warn: (m) => level !== "silent" && write("warn ", m),
    debug: (m) => level === "debug" && write("debug", m),
    redact: (v) => { if (v) secrets.add(v); },
  };
}

export const log = createLogger();
