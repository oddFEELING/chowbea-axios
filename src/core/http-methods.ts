/**
 * Shared HTTP method enumerations.
 *
 * Two sets:
 * - `HTTP_METHODS` covers the 8 methods OpenAPI 3 defines on a Path
 *   Item. Used for discovery: status counts, diff, validate, inspect —
 *   so the user sees their full spec, not just the 5 the generator
 *   knows how to emit today.
 * - `GENERATABLE_HTTP_METHODS` are the 5 methods that the generated
 *   runtime client (`api.client.ts`) exposes as typed wrappers
 *   (`apiClient.get`/`post`/`put`/`delete`/`patch`). The operations
 *   file emits calls only for these; OPTIONS/HEAD/TRACE operations are
 *   discovered but skipped at emission time with a warning.
 *
 * Issue #31.
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

export const GENERATABLE_HTTP_METHODS = [
	"get",
	"post",
	"put",
	"delete",
	"patch",
] as const;

export type GeneratableHttpMethod = (typeof GENERATABLE_HTTP_METHODS)[number];

const GENERATABLE_SET: ReadonlySet<string> = new Set(GENERATABLE_HTTP_METHODS);

/**
 * True when the generator's runtime client has a typed wrapper for the
 * given method. Used to warn (not error) when a spec declares an
 * operation under a method the generator can't emit yet.
 */
export function isGeneratableMethod(method: string): method is GeneratableHttpMethod {
	return GENERATABLE_SET.has(method);
}
