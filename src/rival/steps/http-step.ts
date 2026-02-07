/**
 * HTTP Step Factory
 *
 * Creates a step function that makes an HTTP request.
 *
 * @example
 * ```typescript
 * const fetchUser = httpStep({
 *   url: 'https://api.example.com/users',
 *   method: 'GET',
 * });
 *
 * // Or with dynamic URL from input
 * const fetchUserDynamic = httpStep({
 *   url: ({ input }) => `https://api.example.com/users/${input.userId}`,
 *   method: 'GET',
 * });
 *
 * // POST with body
 * const createUser = httpStep({
 *   url: 'https://api.example.com/users',
 *   method: 'POST',
 *   body: ({ input }) => ({ name: input.name, email: input.email }),
 * });
 * ```
 */

import type { StepContext, StepFunction } from "../types";

/**
 * HTTP request configuration.
 */
export interface HttpStepConfig {
	/** URL string or function that returns URL */
	url: string | ((context: StepContext) => string);
	/** HTTP method */
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
	/** Request headers */
	headers?: Record<string, string> | ((context: StepContext) => Record<string, string>);
	/** Request body (will be JSON stringified if object) */
	body?: unknown | ((context: StepContext) => unknown);
	/** Expected response type */
	responseType?: "json" | "text" | "blob" | "arrayBuffer";
	/** Timeout in milliseconds (default: 30000) */
	timeout?: number;
	/** Whether to throw on non-2xx status (default: true) */
	throwOnError?: boolean;
}

/**
 * HTTP response result.
 */
export interface HttpStepResult {
	/** HTTP status code */
	status: number;
	/** Status text (e.g., "OK", "Not Found") */
	statusText: string;
	/** Response headers */
	headers: Record<string, string>;
	/** Response body (parsed based on responseType) */
	data: unknown;
	/** Request duration in milliseconds */
	duration: number;
}

/**
 * Creates a step function that makes an HTTP request.
 *
 * @param config - HTTP request configuration
 * @returns A step function that executes the HTTP request
 */
export function httpStep(config: HttpStepConfig): StepFunction<unknown, HttpStepResult> {
	const {
		url,
		method = "GET",
		headers,
		body,
		responseType = "json",
		timeout = 30000,
		throwOnError = true,
	} = config;

	return async function httpRequest(context: StepContext): Promise<HttpStepResult> {
		const { log, state } = context;

		// Resolve dynamic values
		const resolvedUrl = typeof url === "function" ? url(context) : url;
		const resolvedHeaders = typeof headers === "function" ? headers(context) : headers;
		const resolvedBody = typeof body === "function" ? body(context) : body;

		log.info({ url: resolvedUrl, method }, `HTTP ${method} request`);

		const startTime = Date.now();

		// Build fetch options
		const fetchOptions: RequestInit = {
			method,
			headers: {
				"Content-Type": "application/json",
				...resolvedHeaders,
			},
			signal: AbortSignal.timeout(timeout),
		};

		// Add body for methods that support it
		if (resolvedBody !== undefined && method !== "GET" && method !== "HEAD") {
			fetchOptions.body =
				typeof resolvedBody === "string" ? resolvedBody : JSON.stringify(resolvedBody);
		}

		// Execute request
		const response = await fetch(resolvedUrl, fetchOptions);
		const duration = Date.now() - startTime;

		// Parse response headers
		const responseHeaders: Record<string, string> = {};
		response.headers.forEach((value, key) => {
			responseHeaders[key] = value;
		});

		// Parse response body
		let data: unknown;
		try {
			switch (responseType) {
				case "json":
					data = await response.json();
					break;
				case "text":
					data = await response.text();
					break;
				case "blob":
					data = await response.blob();
					break;
				case "arrayBuffer":
					data = await response.arrayBuffer();
					break;
			}
		} catch {
			// Response might be empty or not the expected type
			data = null;
		}

		const result: HttpStepResult = {
			status: response.status,
			statusText: response.statusText,
			headers: responseHeaders,
			data,
			duration,
		};

		// Update step state
		state.description = `${method} ${resolvedUrl} → ${response.status} (${duration}ms)`;

		// Check for errors
		if (throwOnError && !response.ok) {
			log.error({ status: response.status, data }, "HTTP request failed");
			throw new Error(`HTTP ${response.status}: ${response.statusText}`);
		}

		log.info({ status: response.status, duration }, "HTTP request completed");
		return result;
	};
}
