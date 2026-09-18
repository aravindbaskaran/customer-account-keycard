import { spawnSync } from "node:child_process";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout;
}

const tracked = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
const configNames = new Set(["keycard.json", "keycard.yaml", "keycard.yml", "identities.json", "identities.yaml", "identities.yml"]);
const forbiddenPaths = tracked.filter((path) => {
  const name = path.split("/").at(-1);
  return name === ".env" || configNames.has(name) || /(^|\/)(?:\.auth|artifacts|sessions)(?:\/|$)/.test(path) || /\.json\.enc$/.test(path);
});
if (forbiddenPaths.length) throw new Error(`sensitive files are tracked: ${forbiddenPaths.join(", ")}`);

const history = git(["log", "--all", "-p", "--format="]);
const shop = "shp";
const gitHub = "git" + "hub";
const npm = "n" + "pm";
const patterns = [
  ["Shopify access token", new RegExp(`${shop}(?:at|ss|ca)_[A-Za-z0-9_]+`)],
  ["GitHub token", new RegExp(`(?:ghp|${gitHub}_pat)_[A-Za-z0-9_]+`)],
  ["npm token", new RegExp(`${npm}_(?!config_cache\\b)[A-Za-z0-9-]+`)],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["private key", /-----BEGIN [A-Z ]+ PRIVATE KEY-----/],
  ["literal API key", /api(?:_|-)?key\s*[:=]\s*["']?[A-Za-z0-9_-]{16}/i],
];
const findings = patterns.flatMap(([name, pattern]) => {
  const match = history.match(pattern);
  return match ? [name] : [];
});
if (findings.length) throw new Error(`possible credential material in Git history: ${findings.join(", ")}`);

console.log(`repository safety check passed (${tracked.length} tracked files scanned; reachable history scanned)`);
