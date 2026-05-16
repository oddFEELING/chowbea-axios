/**
 * Type-level tests for the chowbea-axios generated helpers.
 *
 * Unlike the snapshot tests in `tests/generator.test.ts`, these assert
 * *semantic* behaviour: given a paths/operations/components shape, the
 * helpers must resolve to the right TypeScript types. A regression that
 * produces still-valid TypeScript but with wrong inferred types (e.g.
 * losing `Status extends ...` narrowing, or stripping a required field)
 * would slip past the snapshot tests but fail here.
 *
 * Run with: `npm run test:types`
 */

import { describe, expectTypeOf, it } from "vitest";

import type { components } from "./fixtures/sample-api.types.js";
import type {
	ApiPathParams,
	ApiQueryParams,
	ApiRequestBody,
	ApiResponseData,
	ApiStatusCodes,
	ServerModel,
	ServerRequestBody,
	ServerRequestParams,
	ServerResponseType,
} from "./fixtures/sample-api.helpers.js";

type User = components["schemas"]["User"];
type UserCreate = components["schemas"]["UserCreate"];
type UserUpdate = components["schemas"]["UserUpdate"];
type ErrorResponse = components["schemas"]["ErrorResponse"];
type UploadResult = components["schemas"]["UploadResult"];

describe("ApiResponseData — path-based response inference", () => {
	it("infers the 200 JSON response by default", () => {
		expectTypeOf<ApiResponseData<"/users/{id}", "get">>().toEqualTypeOf<User>();
	});

	it("infers a specific status code when given", () => {
		expectTypeOf<
			ApiResponseData<"/users/{id}", "get", 404>
		>().toEqualTypeOf<ErrorResponse>();
	});

	it("infers a list response (ExpandRecursively may reshape the array)", () => {
		// The current helper wraps every response in `ExpandRecursively`, which
		// distributes over the object/array branch. For `User[]` this means each
		// element is expanded — the array structure survives but is verified
		// element-wise rather than as a strict `User[]`.
		type Got = ApiResponseData<"/users", "get">;
		expectTypeOf<Got[number]>().toEqualTypeOf<User>();
	});

	it("when 200 is absent, distributes over all available statuses", () => {
		// POST /users declares 201 and 400. The default branch
		// `200 extends ... ? 200 : AvailableStatusCodes<P, M>` falls through to
		// the full union, and `ResponseData` then distributes — yielding both
		// the success and the error shape. This is a real footgun worth
		// documenting: callers expecting only the success type get a union.
		expectTypeOf<ApiResponseData<"/users", "post">>().toEqualTypeOf<
			User | ErrorResponse
		>();
	});

	it("rejects status codes that aren't declared on the operation", () => {
		// @ts-expect-error — 418 is not a response status of GET /users/{id}
		type _Bad = ApiResponseData<"/users/{id}", "get", 418>;
	});

	it("defaults to JSON-like media type when Media is not supplied", () => {
		// Multi-media endpoint returns ReportSummary for application/json,
		// string for text/csv, string for application/pdf. The default
		// (`${string}/json`) selects the JSON shape.
		type Default = ApiResponseData<"/reports/{id}", "get">;
		expectTypeOf<Default>().toEqualTypeOf<{
			id: string;
			generatedAt: string;
			rowCount: number;
		}>();
	});

	it("narrows to text/csv when Media is supplied", () => {
		type Csv = ApiResponseData<"/reports/{id}", "get", 200, "text/csv">;
		expectTypeOf<Csv>().toEqualTypeOf<string>();
	});

	it("narrows to application/pdf when Media is supplied", () => {
		type Pdf = ApiResponseData<
			"/reports/{id}",
			"get",
			200,
			"application/pdf"
		>;
		expectTypeOf<Pdf>().toEqualTypeOf<string>();
	});

	it("resolves to `never` for a media type the operation does not declare", () => {
		type Xml = ApiResponseData<
			"/reports/{id}",
			"get",
			200,
			"application/xml"
		>;
		expectTypeOf<Xml>().toBeNever();
	});
});

describe("ApiRequestBody — path-based request inference", () => {
	it("infers a JSON request body", () => {
		expectTypeOf<ApiRequestBody<"/users", "post">>().toEqualTypeOf<UserCreate>();
	});

	it("infers a PATCH request body", () => {
		expectTypeOf<
			ApiRequestBody<"/users/{id}", "patch">
		>().toEqualTypeOf<UserUpdate>();
	});

	it("FIXED in L2: resolves to `undefined` when no body is declared", () => {
		// Body-less operations used to collapse to `unknown` (which lets ANY
		// body through). Since L2 delegated to openapi-typescript-helpers'
		// `OperationRequestBodyContent`, body-less ops correctly resolve to
		// `undefined` — meaning the caller may omit the body entirely but
		// cannot pass a value of any other shape.
		expectTypeOf<ApiRequestBody<"/users/{id}", "get">>().toBeUndefined();
	});

	it("infers a multipart body when only multipart/form-data is declared", () => {
		type UploadBody = ApiRequestBody<"/uploads", "post">;
		expectTypeOf<UploadBody>().toEqualTypeOf<{
			file: string;
			description?: string;
		}>();
	});
});

describe("ApiPathParams — path parameter extraction", () => {
	it("extracts path parameter names from a templated path", () => {
		// The helper currently maps all params to string|number|boolean, regardless of
		// what the OpenAPI parameters object declares. Documenting current behaviour.
		expectTypeOf<ApiPathParams<"/users/{id}">>().toEqualTypeOf<{
			id: string | number | boolean;
		}>();
	});

	it("returns `never` for paths with no parameters", () => {
		expectTypeOf<ApiPathParams<"/users">>().toEqualTypeOf<never>();
	});
});

describe("ApiQueryParams — query parameter extraction", () => {
	it("extracts the query parameters object from the operation", () => {
		expectTypeOf<ApiQueryParams<"/users", "get">>().toEqualTypeOf<{
			limit?: number;
			offset?: number;
			role?: "admin" | "member" | "guest";
		}>();
	});

	it("returns `never` when no query parameters are declared", () => {
		expectTypeOf<ApiQueryParams<"/users/{id}", "get">>().toEqualTypeOf<never>();
	});
});

describe("ApiStatusCodes — declared status enumeration", () => {
	it("returns the union of numeric status codes on the operation", () => {
		expectTypeOf<ApiStatusCodes<"/users/{id}", "get">>().toEqualTypeOf<
			200 | 404
		>();
	});

	it("returns 201 | 400 for POST /users", () => {
		expectTypeOf<ApiStatusCodes<"/users", "post">>().toEqualTypeOf<201 | 400>();
	});
});

describe("ServerRequestBody / ServerRequestParams / ServerResponseType — operation-id helpers", () => {
	it("ServerRequestBody resolves the JSON body by operation id", () => {
		expectTypeOf<ServerRequestBody<"createUser">>().toEqualTypeOf<UserCreate>();
	});

	it("FIXED in L2: ServerRequestBody resolves to `undefined` when no body is declared", () => {
		// Same fix as the ApiRequestBody case above — delegating to
		// `OperationRequestBodyContent` removed the `unknown` collapse.
		expectTypeOf<ServerRequestBody<"getUserById">>().toBeUndefined();
	});

	it("ServerRequestParams collects path params when present", () => {
		expectTypeOf<ServerRequestParams<"getUserById">>().toEqualTypeOf<{
			path: { id: string };
		}>();
	});

	it("ServerRequestParams collects query params when present", () => {
		// listUsers has only `query?:`; the helper omits the `path` key.
		const params = {} as ServerRequestParams<"listUsers">;
		expectTypeOf(params).toMatchTypeOf<{
			query?: {
				limit?: number;
				offset?: number;
				role?: "admin" | "member" | "guest";
			};
		}>();
	});

	it("ServerResponseType defaults to the positive status (201 for createUser)", () => {
		expectTypeOf<ServerResponseType<"createUser">>().toEqualTypeOf<User>();
	});

	it("ServerResponseType accepts an explicit error status", () => {
		expectTypeOf<
			ServerResponseType<"getUserById", 404>
		>().toEqualTypeOf<ErrorResponse>();
	});

	it("ServerResponseType rejects undeclared statuses", () => {
		// @ts-expect-error — 500 is not declared on getUserById
		type _Bad = ServerResponseType<"getUserById", 500>;
	});

	it("ServerResponseType narrows to a specific Media type", () => {
		type Csv = ServerResponseType<"downloadReport", 200, "text/csv">;
		expectTypeOf<Csv>().toEqualTypeOf<string>();

		type Json = ServerResponseType<"downloadReport">;
		expectTypeOf<Json>().toEqualTypeOf<{
			id: string;
			generatedAt: string;
			rowCount: number;
		}>();
	});
});

describe("ServerModel — component schema resolution", () => {
	it("resolves a named schema", () => {
		expectTypeOf<ServerModel<"User">>().toEqualTypeOf<User>();
	});

	it("resolves a different schema", () => {
		expectTypeOf<ServerModel<"UploadResult">>().toEqualTypeOf<UploadResult>();
	});

	it("rejects unknown schema names", () => {
		// @ts-expect-error — "Nope" is not a key of components["schemas"]
		type _Bad = ServerModel<"Nope">;
	});
});
