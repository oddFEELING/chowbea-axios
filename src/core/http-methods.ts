/**
 * Shared HTTP method enumerations.
 *
 * `HTTP_METHODS` covers the 8 methods OpenAPI 3 defines on a Path Item.
 * `GENERATABLE_HTTP_METHODS` is now identical — the runtime client
 * emits typed wrappers for all 8. Issue #31 (fully resolved).
 */

export const HTTP_METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"patch",
	"options",
	"head",
	"trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/**
 * Methods the runtime client emits typed wrappers for. As of #31 this
 * matches HTTP_METHODS exactly (all 8). The constant and helper are
 * retained as defensive anchors in case a non-OpenAPI-3 method (e.g.
 * CONNECT) is encountered in a spec — the helper returns `false` for
 * anything outside this list so callers can skip + warn.
 */
export const GENERATABLE_HTTP_METHODS = HTTP_METHODS;

export type GeneratableHttpMethod = (typeof GENERATABLE_HTTP_METHODS)[number];

const GENERATABLE_SET: ReadonlySet<string> = new Set(GENERATABLE_HTTP_METHODS);

/**
 * True when the runtime client has a typed wrapper for the given
 * method. Used as a defensive anchor for spec-author typos or non-
 * OpenAPI-3 methods (e.g. `connect`) — the generator skips with a
 * warning rather than emitting calls for unrecognized methods.
 */
export function isGeneratableMethod(method: string): method is GeneratableHttpMethod {
	return GENERATABLE_SET.has(method);
}
