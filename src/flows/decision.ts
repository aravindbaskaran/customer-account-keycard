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
import { clickTrustedControl, detectCaptcha, fillTrustedControl } from "./shared.js";
import { isTrustedAuthenticationUrl } from "./trusted-origin.js";

export { isTrustedAuthenticationUrl } from "./trusted-origin.js";

export function effectiveDecisionEngine(engine: DecisionEngine | undefined): DecisionEngine {
  return engine ?? "local-ranker";
}

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
  authForm?: boolean;
  signature?: string;
}

export interface DecisionChoice {
  target: string;
  action: DecisionAction;
}

type DecisionClient = {
  choose(state: { stage: DecisionStage; elements: DecisionElement[]; scope: "auth" | "page"; credentialFilled: boolean }): Promise<DecisionChoice>;
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
const layaRequestTimeoutMs = 15_000;
const jevRequestTimeoutMs = Math.max(1_000, Math.min(60_000, Number(process.env.KEYCARD_JEV_TIMEOUT_MS ?? 15_000) || 15_000));
const jevEndpointOrigin = "https://api.typesafe.ai";
let localRankerModel: LocalRankerModel | null = null;
const decisionClients = new WeakMap<FlowContext, Promise<DecisionClient | null>>();

function isStaleCredentialControlError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("credential control changed since observation");
}

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function cloudControlDescription(description: string): string {
  const withoutContext = description.replace(/\s*\{context=[\s\S]*\}(?= · populated$|$)/g, "");
  const withoutQuery = withoutContext.replace(/href=([^\]]+)/gi, (_match, rawHref: string) => {
    try {
      const parsed = new URL(rawHref, "https://redacted.invalid");
      const cleanHref = /^[a-z][a-z\d+.-]*:\/\//i.test(rawHref) ? `${parsed.origin}${parsed.pathname}` : parsed.pathname;
      return `href=${cleanHref}`;
    } catch {
      return "href=[redacted-url]";
    }
  });
  const decoded = withoutQuery.replace(/(?:%[0-9A-F]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  });
  return decoded.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]");
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

export function controlSignature(tag: string, type: string | null, name: string | null, autocomplete: string | null, href: string | null, formAction: string | null, authForm: boolean): string {
  return [tag, type ?? "", name ?? "", autocomplete ?? "", href ?? "", formAction ?? "", authForm ? "1" : "0"].join("\u001f");
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
    const metadata = await item.evaluate((element) => {
      const control = element as HTMLAnchorElement | HTMLButtonElement | HTMLInputElement;
      const form = (control as HTMLButtonElement | HTMLInputElement).form || element.closest("form");
      const region = element.closest("form, section, aside");
      return {
      tag: element.tagName.toLowerCase(),
      placeholder: element.getAttribute("placeholder"),
      id: element.id || null,
      label: element.getAttribute("aria-label"),
      type: element.getAttribute("type"),
      name: element.getAttribute("name"),
      autocomplete: element.getAttribute("autocomplete"),
      href: control instanceof HTMLAnchorElement ? control.href : null,
      formAction: control instanceof HTMLAnchorElement ? (form ? form.action : "") || "" : (control as HTMLButtonElement | HTMLInputElement).formAction || (form ? form.action : "") || location.href,
      authForm: Boolean(form && form.querySelector('input[type="email"], input[autocomplete="email"], input[autocomplete="one-time-code"], input[inputmode="numeric"]')),
      ariaHidden: element.getAttribute("aria-hidden"),
      inert: element.closest("[inert]") !== null,
        unrelatedRegion: Boolean(region && /newsletter|marketing|subscribe|cookie|consent|product[-_ ]?(option|variant)|quick[-_ ]?view/i.test(`${region.getAttribute("aria-label") || ""} ${region.id || ""} ${region.className || ""}`)),
      carouselControl: element.classList.contains("slider-button") || /^Slide (left|right)$/i.test(element.getAttribute("aria-label") || ""),
      populated: ["INPUT", "TEXTAREA"].includes(element.tagName) && Boolean((element as HTMLInputElement).value),
        context: (() => {
          const attributes = [region ? region.getAttribute("aria-label") : null, region ? region.id : null, region ? region.className : null].filter(Boolean).join(" ");
          const text = (region ? region.textContent : "").replace(/\s+/g, " ").trim().slice(0, 160);
          return [attributes, text].filter(Boolean).join(" ") || null;
        })(),
      };
    }).catch(() => null);
    if (!metadata || metadata.ariaHidden === "true" || metadata.inert || metadata.unrelatedRegion || (excludeUnrelatedCredentialForms && metadata.carouselControl)) continue;
    const editable = ["input", "textarea"].includes(metadata.tag) && !["checkbox", "radio", "submit", "button", "reset", "file"].includes(metadata.type || "");
      result.push({ index, locator: item, editable, observedUrl: page.url(), type: metadata.type, autocomplete: metadata.autocomplete, href: metadata.href, formAction: metadata.formAction, authForm: metadata.authForm, signature: controlSignature(metadata.tag, metadata.type, metadata.name, metadata.autocomplete, metadata.href, metadata.formAction, metadata.authForm), description: describeElement(metadata.tag, metadata.placeholder, metadata.id, metadata.label, metadata.type, metadata.name, metadata.autocomplete, metadata.href, metadata.context, metadata.populated) });
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
  const path = createRequire(import.meta.url).resolve("customer-account-keycard/models/local-ranker.json.gz");
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
      const authenticatedSubmit = element.authForm === true && /type=submit|continue|submit|verify|sign in|log in/i.test(description);
      return authenticatedSubmit || authTextScore(element.description) >= 3 || /account|login|sign in|my account|auth/i.test(description);
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
  if (!isTrustedAuthenticationUrl(element.observedUrl, storeUrl)) return false;
  if (element.href && !isTrustedAuthenticationUrl(new URL(element.href, element.observedUrl).toString(), storeUrl)) return false;
  if (element.formAction && !isTrustedAuthenticationUrl(new URL(element.formAction, element.observedUrl).toString(), storeUrl)) return false;
  return true;
}

export function decisionQuestions(elements: DecisionElement[], stage: DecisionStage = "email", scope: "auth" | "page" = "auth") {
  const clickCandidates = filterAuthCandidates(elements, "CLICK");
  const emailCandidates = stage === "email" && scope === "auth" ? filterAuthCandidates(elements, "FILL_EMAIL") : [];
  const otpCandidates = stage === "otp" ? filterAuthCandidates(elements, "FILL_OTP") : [];
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

export function normalizeDecision(answers: Record<string, { choice?: unknown }> | undefined, elements: DecisionElement[], stage: DecisionStage = "email", scope: "auth" | "page" = "auth", credentialFilled = false): DecisionChoice {
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
  const operations = stage === "email" && scope === "page" ? ["CLICK", "WAIT", "BLOCKED"] : stage === "email" ? ["CLICK", "FILL_EMAIL", "WAIT", "BLOCKED"] : ["CLICK", "FILL_OTP", "WAIT", "BLOCKED"];
  const operationChoice = validateAnswer(answers?.operation, operations);
  if (operationChoice === "WAIT" || operationChoice === "BLOCKED") return { target: "NONE", action: operationChoice };
  const operation = operationChoice as "CLICK" | "FILL_EMAIL" | "FILL_OTP";
  if (credentialFilled && operation !== "CLICK") {
    const clickCandidates = filterAuthCandidates(elements, "CLICK");
    if (clickCandidates.length !== 1) return { target: "NONE", action: "WAIT" };
    return { target: String(elements.indexOf(clickCandidates[0])), action: "CLICK" };
  }
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
  worker.on("exit", (code) => {
    if (code === 0) return;
    const error = new Error(`Laya worker exited with code ${code}`);
    readyReject(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  try {
    await withTimeout(ready, layaLoadTimeoutMs, `Laya model initialization exceeded ${layaLoadTimeoutMs}ms`);
  } catch (error) {
    await worker.terminate();
    await cleanupLayaPartials();
    throw error;
  }
  return {
    async choose(state) {
      const id = requestId++;
      const result = await withTimeout(new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({
          id,
          state: { stage: state.stage, elements: state.elements.map((element) => element.description) },
          questions: decisionQuestions(state.elements, state.stage, state.scope),
        });
      }), layaRequestTimeoutMs, `Laya decision exceeded ${layaRequestTimeoutMs}ms`).finally(() => pending.delete(id));
      const answers = (result as { answers?: Record<string, { choice?: unknown }> }).answers;
      return normalizeDecision(answers, state.elements, state.stage, state.scope, state.credentialFilled);
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
  const endpointUrl = new URL(endpoint);
  if (endpointUrl.origin !== jevEndpointOrigin) throw new Error("TYPESAFE_API_URL must use the approved TypeSafe HTTPS origin");
  return {
    async choose(state) {
      const cloudElements = state.elements.map((element) => ({ ...element, description: cloudControlDescription(element.description) }));
      const response = await fetch(endpointUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: process.env.TYPESAFE_MODEL ?? "jev-latest", state: { subject: `Shopify login ${state.stage}`, body: cloudElements.map((element) => element.description).join("\n") }, questions: decisionQuestions(cloudElements, state.stage, state.scope) }),
        signal: AbortSignal.timeout(jevRequestTimeoutMs),
        redirect: "manual",
      });
      if (!response.ok) throw new Error(`Jev request failed with HTTP ${response.status}`);
      const result = await response.json() as { answers?: Record<string, { choice?: unknown }> };
      return normalizeDecision(result.answers, state.elements, state.stage, state.scope, state.credentialFilled);
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
      return (state.scope === "page" ? choose(clickCandidates, "CLICK") : choose(emailCandidates, "FILL_EMAIL") ?? choose(clickCandidates, "CLICK")) ?? { target: "NONE", action: "WAIT" };
    },
  };
}

async function clientFor(engine: DecisionEngine | undefined): Promise<DecisionClient | null> {
  engine = effectiveDecisionEngine(engine);
  if (engine === "procedural") return null;
  if (engine === "local-ranker") return loadLocalRanker();
  if (engine === "jev") return loadJev();
  if (engine === "laya") return loadLaya();
  if (engine === "auto") {
    try {
      return await loadLaya();
    } catch {
      return loadLocalRanker();
    }
  }
  return null;
}

export async function warmDecisionEngine(engine: DecisionEngine | undefined): Promise<void> {
  if (engine === "laya") await optionalImport("@receptron/laya");
}

async function clientForContext(ctx: FlowContext): Promise<DecisionClient | null> {
  let clientPromise = decisionClients.get(ctx);
  if (!clientPromise) {
    clientPromise = clientFor(ctx.store.decisionEngine);
    decisionClients.set(ctx, clientPromise);
  }
  return clientPromise;
}

export async function closeDecisionEngine(ctx: FlowContext): Promise<void> {
  const clientPromise = decisionClients.get(ctx);
  decisionClients.delete(ctx);
  if (!clientPromise) return;
  const client = await clientPromise;
  await client?.close?.();
}

export async function runDecisionLoop(ctx: FlowContext, stage: DecisionStage, fillOtp: () => Promise<string>, scope: "auth" | "page" = "auth"): Promise<boolean> {
  const engine = effectiveDecisionEngine(ctx.store.decisionEngine);
  let client: DecisionClient | null;
  ctx.log.debug(`decision client loading (${stage}, ${engine})`);
  try {
    client = await clientForContext(ctx);
  } catch (error) {
    if (engine === "auto") return false;
    throw error;
  }
  if (!client) return false;
  ctx.log.debug(`decision client ready (${stage})`);
  ctx.log.debug(`decision loop started (${stage}, ${engine})`);
  let credentialFilled = false;
  let pendingOtp: string | undefined;
  let currentScope = scope;
  let usingAutoLocalFallback = false;
  const clickSelected = async (selected: DecisionElement): Promise<boolean> => {
    const beforeUrl = ctx.page.url();
    try {
      await clickTrustedControl(ctx, selected.locator, "the selected authentication control", selected.signature);
      return true;
    } catch (error) {
      if (isStaleCredentialControlError(error)) {
        ctx.log.debug("credential control changed during observation; re-observing before retrying click");
        await ctx.page.waitForTimeout(100);
        return false;
      }
      if (ctx.page.url() === beforeUrl) throw error;
      ctx.log.debug("selected control detached after navigation; treating click as completed");
      return true;
    }
  };

  for (let step = 0; step < maxSteps; step++) {
    const elements = await visibleInteractiveElements(ctx.page, currentScope);
    if (elements.length === 0) return credentialFilled;
    const candidates = (credentialFilled ? filterAuthCandidates(elements, "CLICK") : elements)
      .filter((element) => hasTrustedDecisionTarget(element, ctx.store.storeUrl));
    if (candidates.length === 0) return false;
    if (credentialFilled && candidates.length === 1) {
      if (!hasTrustedDecisionTarget(candidates[0], ctx.store.storeUrl)) throw new Error("decision engine selected a target outside the store or Shopify authentication origin");
      if (!(await clickSelected(candidates[0]))) continue;
      return true;
    }
    const decisionElements = credentialFilled
      ? candidates.map((element) => element.editable ? { ...element, description: `${element.description} · populated` } : element)
      : candidates;
    ctx.log.debug(`decision step ${step + 1}: ${candidates.length} candidate controls`);
    let choice: DecisionChoice;
    try {
      choice = await client.choose({ stage, elements: decisionElements, scope: currentScope, credentialFilled });
    } catch (error) {
      if (engine === "auto" && !usingAutoLocalFallback) {
        const failedClient = client;
        client = await loadLocalRanker();
        decisionClients.set(ctx, Promise.resolve(client));
        usingAutoLocalFallback = true;
        await failedClient.close?.().catch(() => {});
        choice = await client.choose({ stage, elements: decisionElements, scope: currentScope, credentialFilled });
      } else if (engine === "auto") return false;
      else throw error;
    }
    ctx.log.debug(`decision choice: target=${choice.target}, action=${choice.action}`);
    if (choice.target === "DONE") return true;
    if (choice.action === "WAIT") {
      await ctx.page.waitForTimeout(100);
      continue;
    }
    if (choice.action === "BLOCKED") {
      if (await detectCaptcha(ctx.page)) throw new Error(`decision engine reported BLOCKED during ${stage}`);
      const clickCandidates = filterAuthCandidates(candidates, "CLICK");
      const soleClickable = clickCandidates.length === 1 ? clickCandidates[0] : undefined;
      if (soleClickable) {
        ctx.log.warn(`decision engine blocked an ordinary control during ${stage}; trying the sole visible control`);
        if (!(await clickSelected(soleClickable))) continue;
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
      try {
        await fillTrustedControl(ctx, selected.locator, ctx.shopper.email, selected.signature);
      } catch (error) {
        if (!isStaleCredentialControlError(error)) throw error;
        ctx.log.debug("credential control changed during observation; re-observing before retrying email fill");
        await ctx.page.waitForTimeout(100);
        continue;
      }
      credentialFilled = true;
    } else if (choice.action === "FILL_OTP") {
      if (!selected.editable) throw new Error(`decision engine selected a non-editable element ${choice.target} for OTP`);
      if (!pendingOtp) pendingOtp = await fillOtp();
      try {
        await fillTrustedControl(ctx, selected.locator, pendingOtp, selected.signature);
      } catch (error) {
        if (!isStaleCredentialControlError(error)) throw error;
        ctx.log.debug("credential control changed during observation; re-observing before retrying OTP fill");
        await ctx.page.waitForTimeout(100);
        continue;
      }
      credentialFilled = true;
    }
    else {
      if (!(await clickSelected(selected))) continue;
      if (credentialFilled) return true;
      currentScope = "auth";
      continue;
    }
    ctx.log.debug(`decision action completed: ${choice.action}`);
  }
  if (scope === "page" && !credentialFilled) return false;
  throw new Error(`decision engine exceeded ${maxSteps} actions without completing the ${stage} step`);
}
