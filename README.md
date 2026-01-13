# chowbea-axios

CLI tool for generating TypeScript types and operations from OpenAPI specifications.

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

## Installation

```bash
npm install -g chowbea-axios
```

Or use with npx:

```bash
npx chowbea-axios init
```

## Quick Start

```bash
# Initialize in your project (creates config, generates client files)
chowbea-axios init

# Fetch spec and generate types
chowbea-axios fetch

# Watch for changes during development
chowbea-axios watch
```

## Commands

### `chowbea-axios init`

Interactive setup - prompts for your API endpoint and generates everything.

```bash
chowbea-axios init              # Interactive setup
chowbea-axios init --force      # Overwrite existing config
```

### `chowbea-axios fetch`

Fetch OpenAPI spec and generate types.

```bash
chowbea-axios fetch             # Fetch from configured endpoint
chowbea-axios fetch --force     # Regenerate even if unchanged
chowbea-axios fetch --dry-run   # Preview without writing
```

### `chowbea-axios generate`

Generate types from local spec file.

```bash
chowbea-axios generate                         # Generate from cached spec
chowbea-axios generate --spec-file ./api.json  # Use specific file
```

### `chowbea-axios watch`

Watch for spec changes and regenerate automatically.

```bash
chowbea-axios watch                 # Default 10s interval
chowbea-axios watch --interval 5000 # Poll every 5 seconds
chowbea-axios watch --debug         # Show verbose logs
```

### `chowbea-axios status`

Display current status of config, cache, and generated files.

```bash
chowbea-axios status
```

### `chowbea-axios validate`

Validate OpenAPI spec structure.

```bash
chowbea-axios validate
chowbea-axios validate --strict
```

### `chowbea-axios diff`

Compare current vs new spec.

```bash
chowbea-axios diff
```

## Configuration

Config file `api.config.toml` is created by `init`:

```toml
api_endpoint = "http://localhost:3000/docs/swagger/json"
poll_interval_ms = 10000

[output]
folder = "app/services/api"

[instance]
base_url_env = "VITE_API_URL"
token_key = "auth-token"
with_credentials = true
timeout = 30000

[watch]
debug = false
```

## Generated Files

```
app/services/api/
├── _internal/
│   ├── .api-cache.json      # Cache metadata
│   └── openapi.json         # Cached spec
├── _generated/
│   ├── api.operations.ts    # Generated operations
│   └── api.types.ts         # Generated types
├── api.instance.ts          # Axios instance (editable)
├── api.error.ts             # Error types (editable)
└── api.client.ts            # Typed API client (editable)
```

## Usage

```typescript
import { api } from "./app/services/api/api.client";

// Result-based - never throws
const { data, error } = await api.get("/users/{id}", { id: "123" });

if (error) {
  console.error(error.message);
  return;
}

// data is fully typed
console.log(data.name);
```

## License

MIT
