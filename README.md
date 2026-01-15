# chowbea-axios

CLI tool that turns an OpenAPI spec into a typed Axios client and helpers.

## Full Picture (How it Works)

- `init` creates `api.config.toml`, adds scripts, and generates base client files.
- `fetch` (or `watch`) retrieves your spec into `_internal/openapi.json`.
- Types and operations are generated into `_generated/`.
- You import `api` from `api.client.ts` and call endpoints with full typing.
- Editable files (`api.instance.ts`, `api.error.ts`, `api.client.ts`, `api.helpers.ts`) are generated once and kept.

## Features

- **Self-healing**: Auto-creates config and output directories if missing
- **Retry logic**: Network operations retry 3x with exponential backoff
- **Caching**: Skips regeneration when spec hasn't changed
- **Atomic writes**: Generation never leaves files in a partial state
- **Graceful shutdown**: Watch mode preserves cache on interruption
- **Result-based errors**: API calls return `{ data, error }` instead of throwing
- **Error normalization**: Extracts messages from various API response formats
- **Local spec support**: Use local OpenAPI files instead of remote endpoints
- **Auth headers**: Configure headers with env var interpolation for protected specs

## Installation + Prerequisites

- Node `>=18` (per `package.json`)
- `init` installs `axios` into your project automatically

```bash
# Global install
npm install -g chowbea-axios
```

Or use without installing:

```bash
# One-off usage
npx chowbea-axios init
```

## Quick Start (First Run)

```bash
# 1) Initialize in your project (creates config + base client files)
chowbea-axios init

# 2) Fetch spec and generate types + operations
chowbea-axios fetch

# 3) (Optional) Watch for spec changes during development
chowbea-axios watch
```

Then use the client:

```typescript
import { api } from "./app/services/api/api.client";

// Result-based call (never throws)
const { data, error } = await api.get("/users/{id}", { id: "123" });

if (error) {
  console.error(error.message);
  return;
}

// Typed response data
console.log(data.name);
```

## Configuration Reference

`api.config.toml` is created by `init` and is the main source of truth:

```toml
api_endpoint = "http://localhost:3000/docs/swagger/json"
poll_interval_ms = 10000
# spec_file = "./openapi.json"

[output]
folder = "app/services/api"

[instance]
base_url_env = "VITE_API_URL"
token_key = "auth-token"
with_credentials = true
timeout = 30000

[fetch]
# headers = { Authorization = "Bearer $API_TOKEN" }

[watch]
debug = false
```

- `api_endpoint`: Remote OpenAPI endpoint used by `fetch` and `watch`.
- `spec_file`: Optional local spec path; if set, it overrides `api_endpoint` for generation.
- `poll_interval_ms`: Watch interval if `--interval` is not provided.
- `[output].folder`: Where generated files go (relative to project root).
- `[instance].base_url_env`: Name of the env var read at runtime in `api.instance.ts`.
- `[instance].token_key`: localStorage key used by the axios instance.
- `[instance].with_credentials`: Adds cookies/credentials to requests.
- `[instance].timeout`: Axios request timeout (ms).
- `[fetch].headers`: Extra headers for remote fetch; values can use `$ENV` or `${ENV}`.
- `[watch].debug`: Enables verbose cycle logs.

## Generated Files & Editability

```
app/services/api/
├── _internal/
│   ├── .api-cache.json      # Cache metadata
│   └── openapi.json         # Cached spec
├── _generated/
│   ├── api.operations.ts    # Generated operations (overwritten)
│   └── api.types.ts         # Generated types (overwritten)
├── api.helpers.ts           # Helper types (editable, generated once)
├── api.instance.ts          # Axios instance (editable, generated once)
├── api.error.ts             # Error types (editable, generated once)
└── api.client.ts            # Typed API client (editable, generated once)
```

- `_internal` and `_generated` are always overwritten during generation.
- The root files are generated once and safe to edit.

## Client Usage & Error Handling

All client calls return `{ data, error }` instead of throwing. This keeps error handling explicit and predictable.

```typescript
import { api } from "./app/services/api/api.client";

// Result-based call
const { data, error } = await api.post("/users", { name: "Ada" });

if (error) {
  console.error(error.message);
  return;
}

console.log(data.id);
```

## Helpers (api.helpers.ts)

Use helpers to extract request/response types and schema models when you want explicit type control in app code.

**Base helpers**
- `Paths`: Union of all OpenAPI path strings.
- `HttpMethod`: `"get" | "post" | "put" | "delete" | "patch"`.
- `Expand<T>`: Expands a single level of a type for better intellisense.
- `ExpandRecursively<T>`: Expands nested types for full intellisense.

**Path-based helpers**
- `ApiRequestBody<P, M>`: Request body type for a path + method.
- `ApiResponseData<P, M, Status?>`: Response body type for a path + method.
- `ApiPathParams<P>`: Path params extracted from `{param}` segments.
- `ApiQueryParams<P, M>`: Query params type for a path + method.
- `ApiStatusCodes<P, M>`: Available status codes for a path + method.

**Operation-based helpers**
- `ServerRequestBody<OpId>`: Request body by `operationId`.
- `ServerRequestParams<OpId>`: Path + query params by `operationId`.
- `ServerResponseType<OpId, Status?>`: Response type by `operationId`.

**Schema helpers**
- `ServerModel<ModelName>`: Extract schema types from OpenAPI components.

```typescript
import type {
  Paths,
  HttpMethod,
  Expand,
  ExpandRecursively,
  ApiRequestBody,
  ApiResponseData,
  ApiPathParams,
  ApiQueryParams,
  ApiStatusCodes,
  ServerRequestBody,
  ServerRequestParams,
  ServerResponseType,
  ServerModel,
} from "./app/services/api/api.helpers";

// Path-based helpers
type CreateUserInput = ApiRequestBody<"/users", "post">;
type UserResponse = ApiResponseData<"/users/{id}", "get">;
type UserPath = ApiPathParams<"/users/{id}">;
type UserQuery = ApiQueryParams<"/users", "get">;
type UserStatus = ApiStatusCodes<"/users/{id}", "get">;

// Operation-based helpers (uses operationId keys)
type CreateUserInputByOp = ServerRequestBody<"createUser">;
type UserParamsByOp = ServerRequestParams<"getUserById">;
type UserResponseByOp = ServerResponseType<"getUserById">;

// Schema helpers
type UserModel = ServerModel<"User">;
```

## Path-Based vs Operation-Based Approaches

**Path-based** is great for quick usage when you know the endpoint path:

```typescript
// Calls by path template
const { data, error } = await api.get("/users/{id}", { id: "123" });
```

**Operation-based** uses OpenAPI `operationId` for semantic method names:

```typescript
// Calls by operationId (generated in api.operations.ts)
const { data, error } = await api.op.getUserById({ id: "123" });
```

**When to choose which**
- Path-based: fastest for exploration and when you don’t control `operationId`s.
- Operation-based: cleaner call sites and more stable names when `operationId`s are consistent.

## Command Reference

| Command | Purpose | Key flags |
| --- | --- | --- |
| `chowbea-axios init` | Interactive setup. Prompts for API endpoint, output folder, and package manager. | `--force`, `--skip-scripts`, `--skip-client`, `--skip-concurrent` |
| `chowbea-axios fetch` | Fetch remote spec and generate types/operations. | `-c, --config`, `-e, --endpoint`, `-s, --spec-file`, `-f, --force`, `-n, --dry-run`, `--types-only`, `--operations-only` |
| `chowbea-axios generate` | Generate types/operations from the cached spec (or a local file). | `-c, --config`, `-s, --spec-file`, `-n, --dry-run`, `--types-only`, `--operations-only` |
| `chowbea-axios watch` | Watch for spec changes and regenerate on a timer. | `-c, --config`, `-i, --interval`, `-d, --debug` |
| `chowbea-axios status` | Show config + cache + generated file status. | `-c, --config` |
| `chowbea-axios validate` | Validate the OpenAPI spec structure. | `-c, --config`, `-s, --spec`, `--strict` |
| `chowbea-axios diff` | Compare cached spec with a new spec (remote or local). | `-c, --config`, `-s, --spec` |

## Tips & Troubleshooting

- Re-run `fetch` whenever your API spec changes.
- Use `watch` during local dev to keep types up to date.
- Delete `app/services/api/_internal` to reset cache if types seem stale.
- If scripts are missing, re-run `init` (or add them manually).
- If headers use `$ENV`/`${ENV}`, make sure those env vars are set.

## License

MIT
