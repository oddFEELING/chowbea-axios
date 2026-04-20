# Basic Auth for Swagger Spec Fetching

## Context

The user added Basic Auth to their Swagger JSON endpoint. chowbea-axios now fails to fetch the OpenAPI spec because it can't pass credentials. The existing `[fetch.headers]` config requires manually base64-encoding credentials — this feature adds first-class Basic Auth support with an interactive fallback.

## Design

### New Config Section: `[fetch.auth]`

```toml
[fetch.auth]
type = "basic"
username = "$SWAGGER_USER"     # env var interpolation supported
password = "$SWAGGER_PASS"     # env var interpolation supported
```

- `type`: Only `"basic"` supported for now. Validated at config load time.
- `username` / `password`: Support `$VAR` and `${VAR}` syntax via existing `interpolateEnvVars()`.
- All fields are optional — if `[fetch.auth]` section exists with `type = "basic"` but credentials are missing, the user is prompted interactively.

### New Interface: `FetchAuthConfig`

```typescript
// in src/core/config.ts
export interface FetchAuthConfig {
  type: "basic";
  username?: string;
  password?: string;
}
```

Added as optional field on `FetchConfig`:
```typescript
export interface FetchConfig {
  headers?: Record<string, string>;
  auth?: FetchAuthConfig;
}
```

### PromptProvider Extension

Add `password()` method to the existing `PromptProvider` interface:

```typescript
password(opts: {
  message: string;
  mask?: string;
}): Promise<string>;
```

- **Headless**: Uses `@inquirer/prompts` `password()` (masks input with `*`).
  Only wired when stdin/stdout are TTY — CI/piped contexts skip prompts and
  fall through to the clear "credentials incomplete" error path.
- **TUI**: The `PromptProvider` replay implementations in `init-wizard.tsx`
  and `plugins-manager.tsx` stub `password()` as a no-op returning `""` (they
  don't need credential prompts). The `fetch-generate.tsx` screen handles
  auth differently — it pre-resolves credentials via its own input UI and
  passes them through `FetchActionOptions.auth`, bypassing the
  `PromptProvider` path entirely.

### Auth Resolution Flow

In `executeFetch()`:

1. If `options.auth` is provided (e.g., from TUI pre-resolution), use it directly
2. Otherwise, read `config.fetch?.auth`
3. If `auth.type === "basic"`:
   a. Try to resolve `username` and `password` via env var interpolation
   b. If both resolved → return credentials
   c. If either is missing and a `PromptProvider` is provided (TTY only) → prompt interactively
   d. After prompting, validate non-empty username/password; throw if either is empty
   e. If no `PromptProvider` (non-TTY/CI) → throw error with message to set env vars
4. Pass resolved `{ username, password }` to `fetchOpenApiSpec()`

The headless CLI only constructs its `PromptProvider` when both `process.stdin.isTTY` and `process.stdout.isTTY` are truthy, so CI/piped runs always hit the clear error path instead of hanging on stdin.
4. `fetchOpenApiSpec()` constructs `Authorization: Basic <base64(user:pass)>` header

### Changes to `executeFetch()` Signature

```typescript
export async function executeFetch(
  options: FetchActionOptions,
  logger: Logger,
  prompts?: PromptProvider,  // optional — only needed when auth requires interactive input
): Promise<FetchActionResult>
```

`FetchActionOptions` gains an optional `auth` field for callers (like the TUI) that resolve credentials via their own UI:

```typescript
export interface FetchActionOptions {
  // ... existing fields ...
  auth?: { username: string; password: string };
}
```

### Changes to `fetchOpenApiSpec()`

Add optional `auth` to the options:

```typescript
export async function fetchOpenApiSpec(options: {
  // ... existing fields ...
  auth?: { username: string; password: string };
}): Promise<FetchResult>
```

If `auth` is provided, construct and add the header. Any existing `Authorization` header is removed case-insensitively first, so Basic Auth always wins regardless of how the config header was cased:

```typescript
const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
for (const key of Object.keys(headers)) {
  if (key.toLowerCase() === "authorization") delete headers[key];
}
headers["Authorization"] = `Basic ${credentials}`;
```

### Config Template Update

`generateConfigTemplate()` updated to include commented-out auth section:
```toml
# [fetch.auth]
# type = "basic"
# username = "$SWAGGER_USER"
# password = "$SWAGGER_PASS"
```

## Files to Modify

| File | Change |
|------|--------|
| `src/core/config.ts` | Add `FetchAuthConfig` interface, update `FetchConfig`, add `validateFetchAuthConfig()`, update `generateConfigTemplate()` |
| `src/core/fetcher.ts` | Accept `auth` option in `fetchOpenApiSpec()`, construct Basic Auth header |
| `src/core/actions/fetch.ts` | Add auth resolution logic, accept optional `PromptProvider`, prompt when credentials missing |
| `src/core/actions/init.ts` | Add `password()` to `PromptProvider` interface |
| `src/headless/runner.ts` | Add `password()` to headless prompt provider, pass prompts to `executeFetch()` |
| `src/tui/screens/fetch-generate.tsx` | If `config.fetch?.auth` is configured with incomplete credentials, show username/password input fields before running fetch. Pass resolved credentials via `FetchActionOptions` so no interactive prompt is needed mid-fetch. |

## Error Handling

- Invalid `type` value → `ConfigValidationError` at config load
- Env var not set + non-TTY → clear error: "Set $SWAGGER_USER and $SWAGGER_PASS environment variables, or run interactively"
- User cancels prompt → graceful abort, no stack trace
- 401 after providing credentials → normal `NetworkError` with HTTP 401 status (existing behavior)

## Verification

1. **Config-based auth**: Set env vars `SWAGGER_USER` and `SWAGGER_PASS`, add `[fetch.auth]` to config, run `chowbea-axios fetch` — should succeed
2. **Interactive auth**: Add `[fetch.auth]` with `type = "basic"` but no credentials, run `chowbea-axios fetch` — should prompt for username/password
3. **No auth**: Remove `[fetch.auth]` section — should work exactly as before (no regression)
4. **Invalid config**: Set `type = "invalid"` — should throw validation error
5. **Non-interactive fallback**: Pipe stdin, no env vars — should throw clear error message
