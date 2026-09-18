# Security policy

## What this project handles

keycard holds material that grants access to real customer accounts on real stores:

- **Saved sessions** in `KEYCARD_SESSION_DIR` (default `~/.keycard/sessions`, directory 0700), encrypted with AES-256-GCM using `KEYCARD_KEY`, written atomically (temp file, chmod 600, rename) so a crash cannot leave a partial or world-readable file. A decrypted session is a logged-in customer. Filenames are scoped by a hash of shopper id, store, store URL and email, and a session is rejected on load if it does not match the shopper being asked for, so two projects that both call a shopper `owner` cannot read each other's sessions.
- **Plain exports** written by `keycard export` (typically `.auth/*.json`). These are **not** encrypted, because Playwright needs to read them. Treat one as a password. The MCP server may only write them inside `KEYCARD_MCP_EXPORT_ROOT` (default `./.auth`), and only with a `.json` name.
- **Login codes** fetched from your inbox provider, in memory only, redacted from logs.
- **Secrets** resolved from `env:`, `op://` or `file:` references, never written to disk by keycard and redacted from its logs.

## Reporting a vulnerability

Two private channels, in order of preference:

1. **GitHub private vulnerability reporting**: the Security tab of [aravindbaskaran/customer-account-keycard](https://github.com/aravindbaskaran/customer-account-keycard/security/advisories/new). This keeps the report, the discussion and the eventual advisory in one place, and nothing is public until we publish it.
2. **Email**: cestmoiaravind@gmail.com, subject line starting `keycard security`.

Include what you found, how to reproduce it, and what it exposes. You will get an acknowledgement within a week, and credit in `CREDITS.md` unless you prefer otherwise. Please do not open a public issue for these, and please do not include a real session file, a live login code, or a store credential in the report: describe them instead.

Please report privately if you find a way to:

- read or decrypt a session without `KEYCARD_KEY`,
- make keycard return a session or a code belonging to a different shopper,
- get a secret, a code, or a session into logs, artifacts, or error messages,
- make keycard send credentials anywhere other than the configured store and inbox provider.

Bugs where a login simply fails are ordinary issues; file those publicly.

## If you are using keycard

- Set `KEYCARD_KEY` (32 random bytes, base64). keycard refuses to write sessions without it rather than writing plaintext. Rotate it by deleting the session directory and re-capturing.
- Gitignore `.auth/`, `sessions/`, `artifacts/` and your own `keycard.json`. Delete plain exports when the run ends. Never attach them to CI artifacts or bug reports.
- Put every credential in `keycard.json` behind an `env:`, `op://` or `file:` reference. A literal password in that file is a committed credential the moment someone tracks it, and rotating is then the only real fix.
- Keep `KEYCARD_KEY` and your inbox API key in a secret store, not in the repository.
- Use dedicated test shoppers. Never point keycard at a real customer's account, and never at a store you do not own or are not authorised to test.
- Failure screenshots are **off by default** for that reason. `KEYCARD_ARTIFACTS=1` turns them on; they land in `KEYCARD_ARTIFACT_DIR` (0700, files 0600) and can contain an email address and a live code, so review before sharing.
- Sessions expire (7 days by default, and `validate` makes a real request), but an exported file remains usable until the session is revoked. Signing the shopper out in Shopify invalidates it.
- A session that cannot be confirmed (a 429 from shopify.com, for instance) is kept rather than replaced. That is deliberate, and it means an `UNCONFIRMED` session may be handed to a test. If you need certainty over convenience, set `KEYCARD_REQUIRE_CONFIRMED_SESSION=1`, which fails rather than returning an unconfirmed session, or `KEYCARD_NO_CACHE=1` to pay for a fresh login every run.

## Agent and MCP exposure

`keycard mcp` is a credential-adjacent surface: an agent that can call it can obtain login codes and, if allowed, session cookies. Treat a prompt-injected agent as an attacker. Defaults are therefore deny-first:

| Action | Default | To open it |
|---|---|---|
| Act on a minted (throwaway) shopper | allowed | always |
| Act on a named shopper | refused | `KEYCARD_MCP_SHOPPERS=a,b` or `KEYCARD_MCP_ALLOW_NAMED=1` |
| `get_session` returning cookies inline | metadata only | `KEYCARD_MCP_ALLOW_RAW_SESSION=1` |
| `export_session` target | `.json` inside `./.auth` only, no traversal | `KEYCARD_MCP_EXPORT_ROOT` |

Do not run the MCP server with a config that contains production stores.

## Scope

keycard performs real logins against stores you configure. It contains no CAPTCHA solving, no fingerprint spoofing, and no session forging, and pull requests adding them will be declined. If you need a challenge completed, the `cdp` browser level hands the browser to a human.
