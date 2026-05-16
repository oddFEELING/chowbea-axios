/**
 * Hand-crafted fixture that mimics the shape of an `openapi-typescript`
 * generated `_generated/api.types.ts` file.
 *
 * Why hand-crafted? Running `openapi-typescript` in tests requires a network
 * download (dlx) and the current `runGenerator` helper sets `skipTypes: true`
 * for exactly this reason. Vendoring a representative fixture lets the
 * type-level tests run hermetically.
 *
 * Coverage:
 *   - Multiple paths with multiple methods (incl. HEAD/OPTIONS for L2)
 *   - Path + query parameters
 *   - JSON and multipart (binary) request bodies
 *   - Multiple response statuses (200, 201, 404, default)
 *   - Reused component schemas
 *   - One operation without `operationId` (edge case)
 *
 * NOTE: this fixture does NOT yet model `readOnly` / `writeOnly`. Those will
 * be added when L1 lands and the helpers gain `$Read` / `$Write` awareness.
 */

export interface paths {
	"/users": {
		get: operations["listUsers"];
		post: operations["createUser"];
	};
	"/users/{id}": {
		get: operations["getUserById"];
		patch: operations["updateUser"];
		delete: operations["deleteUser"];
		head: operations["headUser"];
	};
	"/uploads": {
		post: operations["uploadFile"];
	};
	"/health": {
		// Intentionally missing operationId — mirrors a valid OpenAPI edge case.
		get: {
			parameters: {
				query?: never;
				header?: never;
				path?: never;
				cookie?: never;
			};
			requestBody?: never;
			responses: {
				200: {
					content: {
						"application/json": { status: "ok" };
					};
				};
			};
		};
	};
	"/reports/{id}": {
		// Multi-media endpoint — same status, different content types.
		get: operations["downloadReport"];
	};
}

export interface components {
	schemas: {
		User: {
			id: string;
			name: string;
			email: string;
			role: "admin" | "member" | "guest";
		};
		UserCreate: {
			name: string;
			email: string;
			role?: "admin" | "member" | "guest";
		};
		UserUpdate: {
			name?: string;
			email?: string;
		};
		ErrorResponse: {
			code: string;
			message: string;
		};
		UploadResult: {
			id: string;
			bytes: number;
		};
		ReportSummary: {
			id: string;
			generatedAt: string;
			rowCount: number;
		};
	};
	responses: never;
	parameters: never;
	requestBodies: never;
	headers: never;
	pathItems: never;
}

export interface operations {
	listUsers: {
		parameters: {
			query?: {
				limit?: number;
				offset?: number;
				role?: "admin" | "member" | "guest";
			};
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: {
				content: {
					"application/json": components["schemas"]["User"][];
				};
			};
			default: {
				content: {
					"application/json": components["schemas"]["ErrorResponse"];
				};
			};
		};
	};
	createUser: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": components["schemas"]["UserCreate"];
			};
		};
		responses: {
			201: {
				content: {
					"application/json": components["schemas"]["User"];
				};
			};
			400: {
				content: {
					"application/json": components["schemas"]["ErrorResponse"];
				};
			};
		};
	};
	getUserById: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: string;
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: {
				content: {
					"application/json": components["schemas"]["User"];
				};
			};
			404: {
				content: {
					"application/json": components["schemas"]["ErrorResponse"];
				};
			};
		};
	};
	updateUser: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: string;
			};
			cookie?: never;
		};
		requestBody: {
			content: {
				"application/json": components["schemas"]["UserUpdate"];
			};
		};
		responses: {
			200: {
				content: {
					"application/json": components["schemas"]["User"];
				};
			};
			404: {
				content: {
					"application/json": components["schemas"]["ErrorResponse"];
				};
			};
		};
	};
	deleteUser: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: string;
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			204: {
				content: never;
			};
		};
	};
	headUser: {
		parameters: {
			query?: never;
			header?: never;
			path: {
				id: string;
			};
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: {
				content: never;
			};
		};
	};
	uploadFile: {
		parameters: {
			query?: never;
			header?: never;
			path?: never;
			cookie?: never;
		};
		requestBody: {
			content: {
				"multipart/form-data": {
					file: string;
					description?: string;
				};
			};
		};
		responses: {
			201: {
				content: {
					"application/json": components["schemas"]["UploadResult"];
				};
			};
		};
	};
	downloadReport: {
		parameters: {
			query?: never;
			header?: never;
			path: { id: string };
			cookie?: never;
		};
		requestBody?: never;
		responses: {
			200: {
				content: {
					"application/json": components["schemas"]["ReportSummary"];
					"text/csv": string;
					"application/pdf": string;
				};
			};
		};
	};
}

export type $defs = Record<string, never>;
export type webhooks = Record<string, never>;
