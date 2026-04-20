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

- **Headless**: Uses `@inquirer/prompts` `password()` (masks input with `*`)
- **TUI**: Uses masked `input()` component

### Auth Resolution Flow

In `executeFetch()`:

1. Read `config.fetch?.auth`
2. If `auth.type === "basic"`:
   a. Try to resolve `username` and `password` via env var interpolation
   b. If either is missing/empty and stdin is a TTY → prompt interactively via `PromptProvider`
   c. If either is missing/empty and stdin is NOT a TTY → throw error with message to set env vars
3. Pass resolved `{ username, password }` to `fetchOpenApiSpec()`
4. `fetchOpenApiSpec()` constructs `Authorization: Basic <base64(user:pass)>` header

### Changes to `executeFetch()` Signature

```typescript
export async function executeFetch(
  options: FetchActionOptions,
  logger: Logger,
  prompts?: PromptProvider,  // optional — only needed when auth requires interactive input
): Promise<FetchActionResult>
```

### Changes to `fetchOpenApiSpec()`

Add optional `auth` to the options:

```typescript
export async function fetchOpenApiSpec(options: {
  // ... existing fields ...
  auth?: { username: string; password: string };
}): Promise<FetchResult>
```

If `auth` is provided, construct and add the header:
```typescript
const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
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
