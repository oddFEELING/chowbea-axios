<p align="center">
  <img src="https://axios.chowbea.com/images/chowbea-axios.png" alt="chowbea-axios" width="100%" />
</p>

<h1 align="center">Chowbea-axios</h1>

<p align="center">
  Turn your OpenAPI spec into a fully-typed Axios client. One command.
</p>

<p align="center">
  <a href="https://axios.chowbea.com">
    <img src="https://img.shields.io/badge/📚_Read_the_Docs-axios.chowbea.com-10b981?style=for-the-badge" alt="Documentation" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/oddFEELING/chowbea-axios/stargazers"><img src="https://img.shields.io/github/stars/oddFEELING/chowbea-axios?style=flat-square&color=10b981" alt="GitHub stars" /></a>
  <a href="https://www.npmjs.com/package/chowbea-axios"><img src="https://img.shields.io/npm/v/chowbea-axios?style=flat-square&color=10b981" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/chowbea-axios"><img src="https://img.shields.io/npm/dm/chowbea-axios?style=flat-square&color=10b981" alt="npm downloads" /></a>
  <a href="https://github.com/oddFEELING/chowbea-axios/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-10b981?style=flat-square" alt="license" /></a>
</p>

---

## Quick Start

```bash
# Initialize and configure
npx chowbea-axios init

# Fetch spec and generate client
npx chowbea-axios fetch
```

Then import and use:

```typescript
import { api } from "./services/api/api.client";

const { data, error } = await api.op.getUserById({ id: "123" });

if (error) return console.error(error.message);

console.log(data.name); // ✨ Fully typed
```

## Why chowbea-axios?

- **Zero manual types** — Generated directly from your OpenAPI spec
- **Full autocomplete** — Every endpoint, parameter, and response
- **Result-based errors** — `{ data, error }` instead of try/catch
- **Watch mode** — Auto-regenerate when your spec changes

## What Gets Generated

```
services/api/
├── _generated/
│   ├── api.types.ts        # All TypeScript types
│   └── api.operations.ts   # Typed operation methods
├── api.client.ts           # Your API client (editable)
├── api.instance.ts         # Axios instance (editable)
└── api.helpers.ts          # Type helpers (editable)
```

## Commands

| Command | Description |
| ------- | ----------- |
| `init` | Interactive setup — creates config and base files |
| `fetch` | Fetch spec from endpoint and generate types |
| `generate` | Generate from cached/local spec |
| `watch` | Watch for spec changes and auto-regenerate |
| `status` | Show current config and cache status |
| `validate` | Validate your OpenAPI spec |
| `diff` | Compare specs and show changes |

---

<p align="center">
  <a href="https://axios.chowbea.com">
    <strong>→ View full documentation</strong>
  </a>
</p>

## ⭐ Support

If chowbea-axios helps you ship faster, consider giving it a star! It helps others discover the project and motivates continued development.

<p align="center">
  <a href="https://github.com/oddFEELING/chowbea-axios">
    <img src="https://img.shields.io/badge/⭐_Star_on_GitHub-oddFEELING%2Fchowbea--axios-10b981?style=for-the-badge&logo=github" alt="Star on GitHub" />
  </a>
</p>

## License

MIT
