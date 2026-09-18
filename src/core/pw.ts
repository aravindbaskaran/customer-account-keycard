import type * as PW from "playwright-core";

type Runtime = Pick<typeof PW, "chromium" | "request">;

const CANDIDATES = ["playwright", "@playwright/test", "playwright-core"] as const;

let loaded: Promise<Runtime> | null = null;
let loadedFrom = "(not loaded)";

export function loadPlaywright(): Promise<Runtime> {
  if (!loaded) {
    loaded = (async () => {
      const errors: string[] = [];
      for (const name of CANDIDATES) {
        try {
          const mod = (await import(name)) as Runtime;
          if (mod.chromium && mod.request) {
            loadedFrom = name;
            return mod;
          }
          errors.push(`${name}: loaded but exports no chromium/request`);
        } catch (err) {
          errors.push(`${name}: ${(err as Error).message.split("\n")[0]}`);
        }
      }
      throw new Error(`keycard needs playwright, @playwright/test or playwright-core installed in the consuming project (${errors.join("; ")})`);
    })();
  }
  return loaded;
}

export function playwrightSource(): string {
  return loadedFrom;
}
