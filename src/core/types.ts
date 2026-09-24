import type { BrowserContext, Page } from "playwright-core";

export type SecretRef = string;

export type FlowId = "shopify-customer-accounts" | "shopify-classic-customer";
export type BrowserLevel = "headless" | "headed" | "cdp";
export type ChallengeKind = "email-code" | "human";
export type ProviderName = "testmail" | "human";
export type DecisionEngine = "local-ranker" | "auto" | "procedural" | "jev" | "laya";

export interface StoreConfig {
  id: string;
  flow: FlowId;
  storeUrl: string;
  shopId?: string;
  storefrontPassword?: SecretRef;
  pool: { provider: "testmail"; prefix: string };
  ttlHours: number;
  cooldownSeconds: number;
  ladder: BrowserLevel[];
  decisionEngine: DecisionEngine;
}

export interface ChallengeBinding {
  kind: ChallengeKind;
  provider: ProviderName;
  options?: { subjectPattern?: string; codePattern?: string; tag?: string };
}

export interface Shopper {
  id: string;
  store: string;
  email: string;
  role?: string;
  password?: SecretRef;
  ephemeral: boolean;
  meta?: Record<string, string>;
  challenges: ChallengeBinding[];
}

export interface StorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

export interface SavedSession {
  shopperId: string;
  store: string;
  email: string;
  ephemeral: boolean;
  storageState: StorageState;
  createdAt: string;
  expiresAt: string;
  lastValidatedAt: string;
  browserLevel: BrowserLevel;
  keycardVersion: string;
}

export interface ChallengeRequest {
  shopper: Shopper;
  since: number;
  hint: string;
  timeoutMs: number;
}

export interface ChallengeProvider {
  name: ProviderName;
  kinds: ChallengeKind[];
  answer(req: ChallengeRequest, binding: ChallengeBinding): Promise<string>;
}

export class FatalLoginError extends Error {
  fatal = true as const;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
  redact(value: string): void;
}

export interface FlowContext {
  page: Page;
  context: BrowserContext;
  shopper: Shopper;
  store: StoreConfig;
  challenge(kind: ChallengeKind, hint: string, since: number): Promise<string>;
  secret(ref: SecretRef): Promise<string>;
  log: Logger;
}

export type Validity = "valid" | "invalid" | "indeterminate";

export interface Flow {
  id: FlowId;
  login(ctx: FlowContext): Promise<void>;
  postLogin(ctx: FlowContext): Promise<void>;
  validate(session: SavedSession, store: StoreConfig, secret: (ref: SecretRef) => Promise<string>): Promise<Validity>;
  detectCaptcha(page: Page): Promise<boolean>;
}

export interface KeycardConfig {
  version: 1;
  defaults: { ttlHours: number; cooldownSeconds: number; ladder: BrowserLevel[]; challengeTimeoutMs: number; decisionEngine: DecisionEngine };
  providers: {
    testmail?: { apiKey: SecretRef; namespace: SecretRef };
    human?: { channel: "tty" };
  };
  stores: Record<string, StoreConfig>;
  shoppers: Record<string, Shopper>;
  configDir: string;
}
