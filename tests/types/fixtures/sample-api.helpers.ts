/**
 * Vendored copy of the live-generated `api.helpers.ts` template, with the
 * import path remapped to point at the hand-crafted `sample-api.types.ts`
 * fixture in this directory.
 *
 * Drift between this file and the generator's live output is caught by
 * `tests/types/helpers-vendor-drift.test.ts`. If that test fails, regenerate
 * by re-running the helper that produced this file.
 *
 * DO NOT edit by hand — every change should flow from the generator.
 */

import type {
	FilterKeys,
	HttpMethod as HttpMethodAll,
	MediaType,
	OperationRequestBodyContent,
	PathsWithMethod,
	Readable,
	ResponseObjectMap,
	SuccessResponse,
	Writable,
} from "openapi-typescript-helpers";
import type { components, operations, paths } from "./sample-api.types.js";

/* ~ =================================== ~ */
/* -- Base Types -- */
/* ~ =================================== ~ */

/** All path templates defined by the OpenAPI paths map. */
type Paths = keyof paths;

/**
 * HTTP methods supported by the client. The upstream union covers all
 * eight verbs OpenAPI 3 allows (get/post/put/delete/patch/head/options/trace).
 */
type HttpMethod = HttpMethodAll;

/**
 * Resolves the OpenAPI operation schema for a given path and method.
 *
 * The `M & keyof paths[P]` constraint returns `never` (the desired
 * behaviour) for path/method combinations not declared in the spec,
 * and keeps the helper compiling under `noUncheckedIndexedAccess`.
 */
type Operation<P extends Paths, M extends HttpMethod> = paths[P][M & keyof paths[P]];

/* ~ =================================== ~ */
/* -- Path Parameter Extraction -- */
/* ~ =================================== ~ */

/** Extracts placeholder parameter names from an OpenAPI-style path template. */
type ExtractPathParamNames<T extends string> =
	T extends `${string}{${infer P}}${infer R}`
		? P | ExtractPathParamNames<R>
		: never;

/** Maps extracted path parameter names to a simple serializable value type. */
type PathParams<P extends Paths> = ExtractPathParamNames<P & string> extends never
	? never
	: Record<ExtractPathParamNames<P & string>, string | number | boolean>;

/* ~ =================================== ~ */
/* -- Intellisense Helpers -- */
/* ~ =================================== ~ */

/**
 * Forces TypeScript to expand and display the full type structure.
 * Improves intellisense by showing actual type properties instead of type references.
 */
type Expand<T> = T extends (...args: infer A) => infer R
	? (...args: Expand<A>) => Expand<R>
	: T extends object
		? T extends infer O
			? { [K in keyof O]: O[K] }
			: never
		: T;

/**
 * Recursively expands nested types for better intellisense.
 * Expands all levels of nested objects to show full type structure.
 */
type ExpandRecursively<T> = T extends (...args: infer A) => infer R
	? (...args: ExpandRecursively<A>) => ExpandRecursively<R>
	: T extends object
		? T extends infer O
			? { [K in keyof O]: ExpandRecursively<O[K]> }
			: never
		: T;

/* ~ =================================== ~ */
/* -- Path-Based API Type Helpers -- */
/* ~ =================================== ~ */

/**
 * Extract request body type for a given path and method.
 *
 * Returns `undefined` when the operation declares no body. Returns the
 * inferred shape for JSON, multipart, octet-stream — every media type
 * the spec declares — courtesy of `OperationRequestBodyContent`.
 *
 * Wrapped in `Writable<...>` so server-controlled `readOnly` properties
 * (e.g. `id`, `createdAt`) are stripped from request body types — you
 * can't supply them, the server fills them in.
 *
 * @example type CreateUserInput = ApiRequestBody<"/api/users", "post">
 */
export type ApiRequestBody<P extends Paths, M extends HttpMethod> = ExpandRecursively<
	Writable<OperationRequestBodyContent<Operation<P, M>>>
>;

/**
 * Extract response data type for a given path, method, status code, and
 * media type.
 *
 * Defaults to the first 2XX success response and any JSON-like media type
 * (`application/json`, `application/vnd.api+json`, etc.). Pass a Media
 * value to narrow to e.g. `"text/csv"`, `"application/octet-stream"`, or
 * `"text/event-stream"` when the spec declares multiple response shapes.
 *
 * Wrapped in `Readable<...>` so `writeOnly` properties (e.g. `password`)
 * are stripped from response types — the server doesn't return them.
 *
 * @example type UserResponse = ApiResponseData<"/api/users/{id}", "get">
 * @example type CreatedResponse = ApiResponseData<"/api/users", "post", 201>
 * @example type ReportCsv = ApiResponseData<"/api/reports/{id}", "get", 200, "text/csv">
 */
export type ApiResponseData<
	P extends Paths,
	M extends HttpMethod,
	Status extends ApiStatusCodes<P, M> = 200 extends ApiStatusCodes<P, M>
		? 200
		: ApiStatusCodes<P, M>,
	Media extends MediaType = `${string}/json`,
> = ExpandRecursively<
	Readable<
		FilterKeys<
			Operation<P, M> extends { responses: infer R }
				? R extends Record<string | number, unknown>
					? R[Status & keyof R] extends { content: infer C }
						? C
						: never
					: never
				: never,
			Media
		>
	>
>;

/**
 * Extract path parameters for a given path.
 * @example type UserPathParams = ApiPathParams<"/api/users/{id}">
 */
export type ApiPathParams<P extends Paths> = ExpandRecursively<PathParams<P>>;

/**
 * Extract query parameters for a given path and method.
 * @example type ListUsersQuery = ApiQueryParams<"/api/users", "get">
 */
export type ApiQueryParams<P extends Paths, M extends HttpMethod> = ExpandRecursively<
	Operation<P, M> extends { parameters: { query?: infer Q } }
		? Q extends Record<string, unknown>
			? Q
			: never
		: never
>;

/**
 * Get all available status codes for a given path and method.
 * @example type UserStatusCodes = ApiStatusCodes<"/api/users/{id}", "get">
 */
export type ApiStatusCodes<P extends Paths, M extends HttpMethod> = keyof ResponseObjectMap<
	Operation<P, M>
> &
	number;

/**
 * Union of all paths that declare the given method. Useful when narrowing
 * a generic client method to "only paths that actually support GET", etc.
 *
 * @example type ListablePaths = ApiPathsWithMethod<"get">
 */
export type ApiPathsWithMethod<M extends HttpMethod> = PathsWithMethod<paths, M>;

/* ~ =================================== ~ */
/* -- Operation-Based API Type Helpers -- */
/* ~ =================================== ~ */

/** Extracts all available status codes from an operation's responses by operation ID. */
type OperationStatusCodes<OpId extends keyof operations> =
	keyof ResponseObjectMap<operations[OpId]> & number;

/** Determines the default positive status code for an operation. */
type OperationPositiveStatus<OpId extends keyof operations> =
	200 extends OperationStatusCodes<OpId>
		? 200
		: 201 extends OperationStatusCodes<OpId>
			? 201
			: 202 extends OperationStatusCodes<OpId>
				? 202
				: 204 extends OperationStatusCodes<OpId>
					? 204
					: OperationStatusCodes<OpId>;

/**
 * Extract request body type by operation ID.
 *
 * Returns `undefined` when the operation declares no body. Returns the
 * JSON shape (or any other declared media type) when one is present.
 *
 * @example type CreateUserInput = ServerRequestBody<"createUser">
 * @see Use concrete types in _generated/api.contracts.ts for cmd+click navigation
 */
export type ServerRequestBody<OpId extends keyof operations> = ExpandRecursively<
	Writable<OperationRequestBodyContent<operations[OpId]>>
>;

/**
 * Extract request parameters (path and query) by operation ID.
 * @example type GetUserParams = ServerRequestParams<"getUserById">
 * @see Use concrete types in _generated/api.contracts.ts for cmd+click navigation
 */
export type ServerRequestParams<OpId extends keyof operations> = ExpandRecursively<
	operations[OpId] extends { parameters: infer P }
		? P extends { path?: infer Path; query?: infer Query }
			? (Path extends Record<string, unknown> ? { path: Path } : {}) &
					(Query extends Record<string, unknown> ? { query?: Query } : {})
			: P extends { path?: infer Path }
				? Path extends Record<string, unknown>
					? { path: Path }
					: {}
				: P extends { query?: infer Query }
					? Query extends Record<string, unknown>
						? { query?: Query }
						: {}
					: {}
		: {}
>;

/**
 * Extract response type by operation ID, optional status code, and media type.
 *
 * Defaults to the positive status code (200, 201, 202, or 204) and any
 * JSON-like media type. Pass a Media value to narrow to a specific
 * content type.
 *
 * @example type UserResponse = ServerResponseType<"getUserById">
 * @example type NotFoundResponse = ServerResponseType<"getUserById", 404>
 * @example type ReportCsv = ServerResponseType<"downloadReport", 200, "text/csv">
 * @see Use concrete types in _generated/api.contracts.ts for cmd+click navigation
 */
export type ServerResponseType<
	OpId extends keyof operations,
	Status extends OperationStatusCodes<OpId> = OperationPositiveStatus<OpId>,
	Media extends MediaType = `${string}/json`,
> = ExpandRecursively<
	Readable<
		FilterKeys<
			operations[OpId] extends { responses: infer R }
				? R extends Record<string | number, unknown>
					? R[Status & keyof R] extends { content: infer C }
						? C
						: never
					: never
				: never,
			Media
		>
	>
>;

/**
 * The body shape returned by the first 2XX response for an operation,
 * across any declared media type. Equivalent to upstream's
 * `SuccessResponse<ResponseObjectMap<operations[OpId]>>`.
 */
export type ServerSuccessResponse<OpId extends keyof operations> = ExpandRecursively<
	Readable<SuccessResponse<ResponseObjectMap<operations[OpId]>>>
>;

/**
 * Extract model/schema type from OpenAPI components.
 * @example type User = ServerModel<"UserContract">
 * @example type Meeting = ServerModel<"MeetingContract">
 * @see Use concrete types in _generated/api.contracts.ts for cmd+click navigation
 */
export type ServerModel<ModelName extends keyof components["schemas"]> = ExpandRecursively<
	components["schemas"][ModelName]
>;

/* ~ =================================== ~ */
/* -- Re-exports for Convenience -- */
/* ~ =================================== ~ */

export type { Paths, HttpMethod, Expand, ExpandRecursively };
