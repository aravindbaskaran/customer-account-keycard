import type { Locator, Page } from "playwright-core";
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { homedir } from "node:os";
import { chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import type { DecisionEngine, FlowContext } from "../core/types.js";
import { detectCaptcha } from "./shared.js";

export type DecisionStage = "email" | "otp";
export type DecisionAction = "CLICK" | "FILL_EMAIL" | "FILL_OTP" | "WAIT" | "BLOCKED";

export interface DecisionElement {
  index: number;
  locator: Locator;
  description: string;
  editable: boolean;
  observedUrl: string;
  type?: string | null;
  autocomplete?: string | null;
  href?: string | null;
  formAction?: string | null;
}

export interface DecisionChoice {
  target: string;
  action: DecisionAction;
}

type DecisionClient = {
  choose(state: { stage: DecisionStage; elements: DecisionElement[] }): Promise<DecisionChoice>;
  close?(): Promise<void>;
};

type LocalRankerModel = {
  vocab: string[];
  weights: number[];
  bias: number;
  labels: { positive: string[]; negative: string[] };
};

export const interactiveSelector = "a[href], button, input, form [role=\"button\"]";
const maxSteps = 12;
const layaLoadTimeoutMs = 60_000;
const jevRequestTimeoutMs = Math.max(1_000, Math.min(60_000, Number(process.env.KEYCARD_JEV_TIMEOUT_MS ?? 15_000) || 15_000));
let layaClientPromise: Promise<DecisionClient> | null = null;
let localRankerModel: LocalRankerModel | null = null;

function layaWorkerSource(moduleUrl: string): string {
  return String.raw`
import { parentPort } from "node:worker_threads";
import { Laya } from ${JSON.stringify(moduleUrl)};
import { homedir } from "node:os";
import { join } from "node:path";

let model;
try {
  model = await Laya.load({ executionProviders: ["cpu"], cacheDir: process.env.LAYA_CACHE || join(homedir(), ".cache", "receptron-laya") });
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "error", message: error?.message, stack: error?.stack });
}

parentPort.on("message", async ({ id, state, questions }) => {
  if (!model) return parentPort.postMessage({ type: "response", id, error: "Laya model is not available" });
  try {
    const result = await model.systemOne({ subject: "Shopify login " + state.stage, body: state.elements.join("\\n") }, questions);
    parentPort.postMessage({ type: "response", id, result });
  } catch (error) {
    parentPort.postMessage({ type: "response", id, error: error?.message, stack: error?.stack });
  }
});
`;
}

function optionalImport(specifier: string): Promise<Record<string, unknown>> {
  return import(specifier) as Promise<Record<string, unknown>>;
}

async function cleanupLayaPartials(): Promise<void> {
  const root = process.env.LAYA_CACHE || join(homedir(), ".cache", "receptron-laya");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const match = entry.name.match(/\.part-(\d+)$/);
        if (!match) continue;
        try {
          process.kill(Number(match[1]), 0);
        } catch {
          await unlink(path).catch(() => {});
        }
      }
    }
  };
  await visit(root);
}

function describeElement(tag: string, placeholder: string | null, id: string | null, label: string | null, type: string | null, name: string | null, autocomplete: string | null, href: string | null, context: string | null, populated = false): string {
  const hint = placeholder || id || label || "";
  const semantic = [type && `type=${type}`, name && `name=${name}`, autocomplete && `autocomplete=${autocomplete}`, href && `href=${href}`].filter(Boolean).join(", ");
  const region = context ? ` {context=${context.slice(0, 100)}}` : "";
  return `${tag}${hint ? ` · ${hint.slice(0, 80)}` : ""}${semantic ? ` [${semantic.slice(0, 120)}]` : ""}${region}${populated ? " · populated" : ""}`;
}

export async function visibleInteractiveElements(page: Page, scope: "auth" | "page" = "auth"): Promise<DecisionElement[]> {
  let locator = page.locator(interactiveSelector);
  if (scope === "page") return collectInteractiveElements(page, locator, true);
  const activeSurface = page.locator('shopify-login-form form:visible, [role="dialog"] form:visible').first();
  if (await activeSurface.count() > 0) locator = activeSurface.locator(interactiveSelector);
  const forms = page.locator("form:visible");
  for (let formIndex = 0; await activeSurface.count() === 0 && formIndex < await forms.count(); formIndex++) {
    const form = forms.nth(formIndex);
    const credentialInput = form.locator('input[type="email"], input[autocomplete="email"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
    if (await credentialInput.count() > 0) {
      locator = form.locator(interactiveSelector);
      break;
    }
  }
  return collectInteractiveElements(page, locator, false);
}

async function collectInteractiveElements(page: Page, locator: Locator, excludeUnrelatedCredentialForms: boolean): Promise<DecisionElement[]> {
  const result: DecisionElement[] = [];
  for (let index = 0; index < await locator.count(); index++) {
    const item = locator.nth(index);
    if (!(await item.isVisible().catch(() => false)) || !(await item.isEnabled().catch(() => false))) continue;
    const metadata = await item.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      placeholder: element.getAttribute("placeholder"),
      id: element.id || null,
      label: element.getAttribute("aria-label"),
      type: element.getAttribute("type"),
      name: element.getAttribute("name"),
      autocomplete: element.getAttribute("autocomplete"),
      href: element.getAttribute("href"),
      formAction: element.closest("form")?.getAttribute("action") || null,
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.closest("[inert]") !== null,
        unrelatedRegion: Boolean(element.closest("form, section, aside") && /newsletter|marketing|subscribe|cookie|consent|product[-_ ]?(option|variant)|quick[-_ ]?view/i.test(`${element.closest("form, section, aside")?.getAttribute("aria-label") || ""} ${element.closest("form, section, aside")?.id || ""} ${element.closest("form, section, aside")?.className || ""}`)),
      carouselControl: element.classList.contains("slider-button") || /^Slide (left|right)$/i.test(element.getAttribute("aria-label") || ""),
      populated: ["INPUT", "TEXTAREA"].includes(element.tagName) && Boolean((element as HTMLInputElement).value),
        context: (() => {
          const region = element.closest("form, section, aside");
          const attributes = [region?.getAttribute("aria-label"), region?.id, region?.className].filter(Boolean).join(" ");
          const text = (region?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
          return [attributes, text].filter(Boolean).join(" ") || null;
        })(),
    })).catch(() => null);
    if (!metadata || metadata.ariaHidden === "true" || metadata.inert || metadata.unrelatedRegion || (excludeUnrelatedCredentialForms && metadata.carouselControl)) continue;
    const editable = ["input", "textarea"].includes(metadata.tag) && !["checkbox", "radio", "submit", "button", "reset", "file"].includes(metadata.type || "");
      result.push({ index, locator: item, editable, observedUrl: page.url(), type: metadata.type, autocomplete: metadata.autocomplete, href: metadata.href, formAction: metadata.formAction, description: describeElement(metadata.tag, metadata.placeholder, metadata.id, metadata.label, metadata.type, metadata.name, metadata.autocomplete, metadata.href, metadata.context, metadata.populated) });
  }
  return result;
}

function authTextScore(description: string): number {
  const text = description.toLowerCase();
  const positives = ["account", "login", "log in", "sign in", "my account", "customer account", "auth", "profile"];
  const negatives = ["search", "cart", "wishlist", "newsletter", "subscribe", "sign up", "cookie", "consent", "promo", "sale", "carousel", "slide", "menu", "hamburger", "bag", "checkout", "continue shopping", "browse", "learn more", "membership", "alliance", "rewards", "loyalty", "affiliate"];
  const emailSignals = ["email", "username", "customer email"];
  const otpSignals = ["one-time-code", "otp", "verification code", "enter code"];

  let score = 0;
  for (const term of positives) if (text.includes(term)) score += 3;
  for (const term of negatives) if (text.includes(term)) score -= 4;
  for (const term of emailSignals) if (text.includes(term)) score += 2;
  for (const term of otpSignals) if (text.includes(term)) score += 2;
  return score;
}

function loadLocalRankerModel(): LocalRankerModel {
  if (localRankerModel) return localRankerModel;
  const packageRoot = pathToFileURL(join(process.cwd(), "package.json"));
  const path = createRequire(packageRoot).resolve("customer-account-keycard/models/local-ranker.json.gz");
  const value: unknown = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("local ranker model must be an object");
  const model = value as Partial<LocalRankerModel>;
  const { vocab, weights, bias, labels } = model;
  if (!Array.isArray(vocab) || !Array.isArray(weights) || typeof bias !== "number" || !Number.isFinite(bias) || !labels || !Array.isArray(labels.positive) || !Array.isArray(labels.negative)) {
    throw new Error("local ranker model has an invalid schema");
  }
  if (!vocab.length || vocab.length > 4096 || vocab.length !== weights.length || vocab.some((token) => typeof token !== "string" || !token) || weights.some((weight) => typeof weight !== "number" || !Number.isFinite(weight))) {
    throw new Error("local ranker model has invalid weights");
  }
  const parsedModel: LocalRankerModel = { vocab, weights, bias, labels };
  localRankerModel = parsedModel;
  return parsedModel;
}

function localRankerFeatures(element: DecisionElement): Map<string, number> {
  const fields = [element.description, element.type ?? "", element.autocomplete ?? "", element.href ?? "", element.formAction ?? ""];
  const text = fields.join(" ").toLowerCase();
  const features = new Map<string, number>();
  for (const token of text.match(/[a-z0-9]+/g) ?? []) features.set(token, (features.get(token) ?? 0) + 1);
  const add = (feature: string, value: number) => features.set(feature, (features.get(feature) ?? 0) + value);
  if (/account|login|log in|sign in|my account|customer account|auth|profile/.test(text)) add("__auth_entry__", 1);
  if (/email|username|customer email/.test(text)) add("__email_field__", 1);
  if (/password|current-password/.test(text)) add("__password_field__", 1);
  if (/one-time-code|otp|verification code|enter code/.test(text)) add("__otp_field__", 1);
  if (/login|log in|sign in|account|customer/.test(text)) add("__auth_context__", 1);
  if (/(?:\/account(?:\/|$)|\/login(?:\/|$)|customer_authentication|apps\/account)/.test(text)) add("__auth_route__", 10);
  if (/(?:x\.com|twitter\.com|facebook\.com|pinterest\.com|instagram\.com|youtube\.com|tiktok\.com|linkedin\.com)/.test(text)) add("__social_link__", 3);
  if (/search|cart|wishlist|newsletter|subscribe|cookie|consent|promo|sale|carousel|membership|alliance|rewards|loyalty|affiliate/.test(text)) add("__negative_context__", 2);
  if (/newsletter|subscribe|sign up|marketing|promo|discount|rewards|loyalty/.test(text)) add("__marketing_context__", 3);
  return features;
}

export function scoreLocalRanker(element: DecisionElement): number {
  const model = loadLocalRankerModel();
  const features = localRankerFeatures(element);
  let score = model.bias;
  for (let index = 0; index < model.vocab.length; index++) score += (features.get(model.vocab[index]) ?? 0) * model.weights[index];
  if (score >= 0) return 1 / (1 + Math.exp(-score));
  const exponent = Math.exp(score);
  return exponent / (1 + exponent);
}

export function rankLocalCandidates(elements: DecisionElement[], action: "CLICK" | "FILL_EMAIL" | "FILL_OTP"): DecisionElement[] {
  return filterAuthCandidates(elements, action)
    .map((element) => ({ element, score: scoreLocalRanker(element) }))
    .sort((left, right) => right.score - left.score || left.element.index - right.element.index)
    .map(({ element }) => element);
}

export function filterAuthCandidates(elements: DecisionElement[], operation: "CLICK" | "FILL_EMAIL" | "FILL_OTP"): DecisionElement[] {
  return elements.filter((element) => {
    const description = element.description.toLowerCase();
    if (operation === "CLICK") {
      if (element.editable) return false;
      const unrelatedControl = /search|cart|wishlist|newsletter|subscribe|cookie|consent|promo|sale|carousel|slide|menu|hamburger|bag|checkout|continue shopping|browse|learn more|sort|filter|language|currency|membership|alliance|rewards|loyalty|affiliate/i.test(description);
      const explicitSignIn = /sign in|log in|login/i.test(description);
      if (unrelatedControl && !explicitSignIn) return false;
      return authTextScore(element.description) >= 3 || /account|login|sign in|my account|auth/i.test(description);
    }
    if (operation === "FILL_EMAIL") {
      if (!element.editable) return false;
      if (/newsletter|subscribe|sign up|marketing|promo|discount|rewards|loyalty/i.test(description)) return false;
      return /email|username|customer email/i.test(description) || authTextScore(element.description) >= 2;
    }
    if (!element.editable) return false;
    if (/newsletter|subscribe|sign up|marketing|promo|discount|rewards|loyalty/i.test(description)) return false;
    return /one-time-code|otp|verification code|enter code|code/i.test(description) || authTextScore(element.description) >= 2;
  });
}

export function hasTrustedDecisionTarget(element: DecisionElement, storeUrl: string): boolean {
  const target = element.href ?? element.formAction ?? element.observedUrl;
  let url: URL;
  try {
    url = new URL(target, element.observedUrl);
  } catch {
    return false;
  }
  return url.origin === new URL(storeUrl).origin || (url.protocol === "https:" && url.hostname === "shopify.com");
}

export function decisionQuestions(elements: DecisionElement[]) {
  const clickCandidates = filterAuthCandidates(elements, "CLICK");
  const emailCandidates = filterAuthCandidates(elements, "FILL_EMAIL");
  const otpCandidates = filterAuthCandidates(elements, "FILL_OTP");
  const targetCriteria = (candidates: DecisionElement[]) => Object.fromEntries(candidates.map((element, index) => [String(index), `[${element.index}] ${element.description}`]));
  const clickCriteria = targetCriteria(clickCandidates);
  const emailCriteria = targetCriteria(emailCandidates);
  const otpCriteria = targetCriteria(otpCandidates);
  const operations: Record<string, string> = {};
  if (Object.keys(clickCriteria).length) operations.CLICK = "Click a visible account/login control.";
  operations.WAIT = "Wait briefly because the needed control may still be loading.";
  operations.BLOCKED = "Use only when the visible UI explicitly identifies CAPTCHA, reCAPTCHA, hCaptcha, bot detection, or asks for human verification; do not use this for an unfamiliar ordinary control.";
  if (Object.keys(emailCriteria).length) {
    operations.FILL_EMAIL = "Fill the visible email input.";
  }
  if (Object.keys(otpCriteria).length) {
    operations.FILL_OTP = "Fill the visible one-time-code input.";
  }
  const questions: Record<string, unknown> = {
    operation: {
      type: "choice" as const,
      instructions: "Choose the next login operation. Prefer an account, sign-in, or login control over search, navigation, carousel, product, cookie, newsletter, or marketing controls. Do not repeat a satisfied credential fill.",
      criteria: operations,
    },
  };
  if (Object.keys(clickCriteria).length) questions.click_target = { type: "choice", instructions: "Choose the visible account/login entry control. Avoid generic navigation, search, cart, carousel, cookie, newsletter, and product controls.", criteria: clickCriteria };
  if (Object.keys(emailCriteria).length) {
    questions.fill_email_target = { type: "choice", instructions: "Choose the target email input.", criteria: emailCriteria };
  }
  if (Object.keys(otpCriteria).length) {
    questions.fill_otp_target = { type: "choice", instructions: "Choose the target one-time-code input.", criteria: otpCriteria };
  }
  return questions;
}

export function normalizeDecision(answers: Record<string, { choice?: unknown }> | undefined, elements: DecisionElement[]): DecisionChoice {
  const validateAnswer = (answer: { choice?: unknown; confidence?: unknown; probabilities?: unknown } | undefined, allowed: string[]) => {
    if (!answer || typeof answer.choice !== "string" || !allowed.includes(answer.choice)) throw new Error(`decision engine returned invalid choice ${String(answer?.choice)}; expected one of ${allowed.join(",")}`);
    if (answer.confidence !== undefined && (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1)) throw new Error("decision engine returned invalid confidence");
    if (answer.probabilities !== undefined) {
      const probabilities = answer.probabilities as Record<string, unknown>;
      const values = Object.values(probabilities);
      const numericValues = values.filter((value): value is number => typeof value === "number");
      if (Object.keys(probabilities).some((key) => !allowed.includes(key)) || numericValues.length !== values.length || numericValues.some((value) => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(numericValues.reduce((sum: number, value: number) => sum + value, 0) - 1) > 0.02) throw new Error("decision engine returned invalid probabilities");
      const selectedProbability = probabilities[answer.choice] as number | undefined;
      if (selectedProbability !== undefined && selectedProbability < Math.max(...numericValues) - 1e-6) throw new Error("decision engine selected a non-maximal choice");
    }
    return answer.choice;
  };
  if (answers?.operation?.choice === "DONE") return { target: "DONE", action: "CLICK" };
  const operationChoice = validateAnswer(answers?.operation, ["CLICK", "FILL_EMAIL", "FILL_OTP", "WAIT", "BLOCKED"]);
  if (operationChoice === "WAIT" || operationChoice === "BLOCKED") return { target: "NONE", action: operationChoice };
  const operation = operationChoice as "CLICK" | "FILL_EMAIL" | "FILL_OTP";
  const key = operation === "CLICK" ? "click_target" : operation === "FILL_EMAIL" ? "fill_email_target" : "fill_otp_target";
  const candidates = operation === "CLICK" ? filterAuthCandidates(elements, "CLICK") : operation === "FILL_EMAIL" ? filterAuthCandidates(elements, "FILL_EMAIL") : filterAuthCandidates(elements, "FILL_OTP");
  if (!candidates.length) {
    throw new Error(`decision engine returned no domain-valid ${operation.toLowerCase().replace("_", " ")} target`);
  }
  const allowedTargets = candidates.map((_, index) => String(index));
  const targetAnswer = answers?.[key];
  const target = targetAnswer?.choice === undefined && candidates.length === 1 ? "0" : validateAnswer(targetAnswer, allowedTargets);
  const selected = candidates[Number(target)];
  if (!selected) throw new Error("decision engine returned no compatible target");
  return { target: String(elements.indexOf(selected)), action: operation };
}

async function loadLaya(): Promise<DecisionClient> {
  await cleanupLayaPartials();
  const cacheDir = process.env.LAYA_CACHE || join(homedir(), ".cache", "receptron-laya");
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await chmod(cacheDir, 0o700).catch(() => {});
  const moduleUrl = pathToFileURL(createRequire(pathToFileURL(join(process.cwd(), "package.json"))).resolve("@receptron/laya")).href;
  await optionalImport("@receptron/laya");
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(layaWorkerSource(moduleUrl))}`));
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let requestId = 0;
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  worker.on("message", (message: { type: string; id?: number; result?: unknown; error?: string; stack?: string }) => {
    if (message.type === "ready") return readyResolve();
    if (message.type === "error") return readyReject(Object.assign(new Error(message.error ?? "Laya worker failed"), { stack: message.stack }));
    if (message.type === "response" && message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(Object.assign(new Error(message.error), { stack: message.stack }));
      else request.resolve(message.result);
    }
  });
  worker.on("error", (error) => {
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Laya model initialization exceeded ${layaLoadTimeoutMs}ms`)), layaLoadTimeoutMs)),
    ]);
  } catch (error) {
    await worker.terminate();
    await cleanupLayaPartials();
    throw error;
  }
  return {
    async choose(state) {
      const result = await new Promise<unknown>((resolve, reject) => {
        const id = requestId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({
          id,
          state: { stage: state.stage, elements: state.elements.map((element) => element.description) },
          questions: decisionQuestions(state.elements),
        });
      });
      const answers = (result as { answers?: Record<string, { choice?: unknown }> }).answers;
      return normalizeDecision(answers, state.elements);
    },
    async close() {
      const error = new Error("Laya decision worker closed");
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      await worker.terminate();
    },
  };
}

async function loadJev(): Promise<DecisionClient> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error("TYPESAFE_API_KEY is required for the Jev decision engine");
  const endpoint = process.env.TYPESAFE_API_URL ?? "https://api.typesafe.ai/v1/systemone";
  return {
    async choose(state) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.TYPESAFE_MODEL ?? "jev-latest", state: { subject: `Shopify login ${state.stage}`, body: state.elements.map((element) => element.description).join("\n") }, questions: decisionQuestions(state.elements) }),
        signal: AbortSignal.timeout(jevRequestTimeoutMs),
      });
      if (!response.ok) {
        const detail = (await response.text()).replace(/\s+/g, " ").slice(0, 500);
        throw new Error(`Jev request failed with HTTP ${response.status}: ${detail}`);
      }
      const result = await response.json() as { answers?: Record<string, { choice?: unknown }> };
      return normalizeDecision(result.answers, state.elements);
    },
  };
}

async function loadLocalRanker(): Promise<DecisionClient> {
  return {
    async choose(state) {
      const clickCandidates = rankLocalCandidates(state.elements, "CLICK");
      const emailCandidates = rankLocalCandidates(state.elements, "FILL_EMAIL");
      const otpCandidates = rankLocalCandidates(state.elements, "FILL_OTP");
      const choose = (candidates: DecisionElement[], action: DecisionAction): DecisionChoice | undefined => {
        const selected = candidates[0];
        return selected ? { target: String(state.elements.indexOf(selected)), action } : undefined;
      };
      if (state.stage === "otp") {
        return choose(otpCandidates, "FILL_OTP") ?? choose(clickCandidates, "CLICK") ?? { target: "NONE", action: "WAIT" };
      }
      return choose(emailCandidates, "FILL_EMAIL") ?? choose(clickCandidates, "CLICK") ?? { target: "NONE", action: "WAIT" };
    },
  };
}

async function clientFor(engine: DecisionEngine): Promise<DecisionClient | null> {
  if (engine === "procedural") return null;
  if (engine === "local-ranker") return loadLocalRanker();
  if (engine === "jev") return loadJev();
  if (engine === "laya") {
    layaClientPromise ??= loadLaya();
    return layaClientPromise;
  }
  if (engine === "auto") {
    try {
      layaClientPromise ??= loadLaya();
      return await layaClientPromise;
    } catch {
      return loadLocalRanker();
    }
  }
  return null;
}

export async function warmDecisionEngine(engine: DecisionEngine): Promise<void> {
  if (engine !== "laya") return;
  try {
    await clientFor(engine);
  } catch (error) {
    throw error;
  }
}

export async function closeDecisionEngine(engine: DecisionEngine): Promise<void> {
  if (engine !== "laya" && engine !== "auto") return;
  const clientPromise = layaClientPromise;
  layaClientPromise = null;
  if (!clientPromise) return;
  await (await clientPromise).close?.();
}

export async function runDecisionLoop(ctx: FlowContext, stage: DecisionStage, fillOtp: () => Promise<string>, scope: "auth" | "page" = "auth"): Promise<boolean> {
  let client: DecisionClient | null;
  ctx.log.debug(`decision client loading (${stage}, ${ctx.store.decisionEngine})`);
  try {
    client = await clientFor(ctx.store.decisionEngine);
  } catch (error) {
    if (ctx.store.decisionEngine === "auto") return false;
    throw error;
  }
  if (!client) return false;
  ctx.log.debug(`decision client ready (${stage})`);
  ctx.log.debug(`decision loop started (${stage}, ${ctx.store.decisionEngine})`);
  let credentialFilled = false;
  let currentScope = scope;
  const clickSelected = async (selected: DecisionElement): Promise<void> => {
    const beforeUrl = ctx.page.url();
    try {
      await selected.locator.click({ timeout: 8_000 });
    } catch (error) {
      if (ctx.page.url() === beforeUrl) throw error;
      ctx.log.debug("selected control detached after navigation; treating click as completed");
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    const elements = await visibleInteractiveElements(ctx.page, currentScope);
    if (elements.length === 0) return credentialFilled;
    const candidates = credentialFilled ? filterAuthCandidates(elements, "CLICK") : elements;
    if (candidates.length === 0) return credentialFilled;
    if (credentialFilled && candidates.length === 1) {
      await clickSelected(candidates[0]);
      return true;
    }
    const decisionElements = credentialFilled
      ? candidates.map((element) => element.editable ? { ...element, description: `${element.description} · populated` } : element)
      : candidates;
    ctx.log.debug(`decision step ${step + 1}: ${candidates.length} candidate controls`);
    let choice: DecisionChoice;
    try {
      choice = await client.choose({ stage, elements: decisionElements });
    } catch (error) {
      if (ctx.store.decisionEngine === "auto") return false;
      throw error;
    }
    ctx.log.debug(`decision choice: target=${choice.target}, action=${choice.action}`);
    if (choice.target === "DONE") return true;
    if (choice.action === "WAIT") {
      await ctx.page.waitForTimeout(100);
      continue;
    }
    if (choice.action === "BLOCKED") {
      if (await detectCaptcha(ctx.page)) throw new Error(`decision engine reported BLOCKED during ${stage}`);
      const soleClickable = candidates.length === 1 && !candidates[0].editable ? candidates[0] : undefined;
      if (soleClickable) {
        ctx.log.warn(`decision engine blocked an ordinary control during ${stage}; trying the sole visible control`);
        await clickSelected(soleClickable);
        currentScope = "auth";
        continue;
      }
      throw new Error(`decision engine reported BLOCKED during ${stage}`);
    }
    const index = Number(choice.target);
    const selected = Number.isInteger(index) ? candidates[index] : undefined;
    if (!selected) throw new Error(`decision engine selected unavailable element ${choice.target}`);
    if (selected.observedUrl !== ctx.page.url()) throw new Error("decision engine action came from a stale page observation");
    if (!hasTrustedDecisionTarget(selected, ctx.store.storeUrl)) throw new Error("decision engine selected a target outside the store or Shopify authentication origin");
    if (credentialFilled && !selected.editable && (choice.action === "FILL_EMAIL" || choice.action === "FILL_OTP")) {
      ctx.log.debug(`normalizing stale fill action to CLICK for target=${choice.target}`);
      await clickSelected(selected);
      return true;
    }
    if (choice.action === "FILL_EMAIL") {
      if (!selected.editable) throw new Error(`decision engine selected a non-editable element ${choice.target} for email`);
      await selected.locator.fill(ctx.shopper.email);
      credentialFilled = true;
    } else if (choice.action === "FILL_OTP") {
      if (!selected.editable) throw new Error(`decision engine selected a non-editable element ${choice.target} for OTP`);
      await selected.locator.fill(await fillOtp());
      credentialFilled = true;
    }
    else {
      await clickSelected(selected);
      if (credentialFilled) return true;
      currentScope = "auth";
      continue;
    }
    ctx.log.debug(`decision action completed: ${choice.action}`);
  }
  throw new Error(`decision engine exceeded ${maxSteps} actions without completing the ${stage} step`);
}
