declare const __KEYCARD_VERSION__: string | undefined;
export const VERSION: string = typeof __KEYCARD_VERSION__ === "string" ? __KEYCARD_VERSION__ : "0.0.0-dev";
