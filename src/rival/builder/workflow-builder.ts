/**
 * Workflow Builder
 *
 * Fluent API for defining workflows in a type-safe way.
 *
 * @example
 * ```typescript
 * const workflow = createWorkflow('processOrder')
 *   .input(z.object({ orderId: z.string() }))
 *   .step(validateOrder)
 *   .step({ fn: processPayment, timeout: 30000 })
 *   .step(sendConfirmation)
 *   .onError(handleError)
 *   .build();
 * ```
 */

import type { ZodSchema } from "zod";
import type {
	ErrorHandler,
	ForEachDefinition,
	StepActorConfig,
	StepConfig,
	StepDefinition,
	StepFunction,
} from "../types";
import type { WorkflowDefinition } from "../types";

/**
 * Step input for the builder - either a function or an object with fn and config.
 */
export type StepInput =
	| StepFunction
	| {
			fn: StepFunction;
			name?: string;
			timeout?: number;
			actor?: StepActorConfig;
			maxAttempts?: number;
			onTimeout?: "stop" | "retry";
			backoff?: "linear" | "exponential";
			onError?: ErrorHandler;
	  };

/**
 * Input for the forEach builder method.
 */
export interface ForEachInput {
	/** Step function that returns the items array to iterate over */
	items: StepFunction;
	/** Body: a single step function or a workflow definition */
	do: StepFunction | WorkflowDefinition;
	/** Run iterations in parallel (fan-out/fan-in) */
	parallel?: boolean;
	/** Max in-flight iterations when parallel is true */
	concurrency?: number;
}

/**
 * Workflow builder for fluent API.
 */
export class WorkflowBuilder {
	private readonly _name: string;
	private _steps: (StepDefinition | ForEachDefinition)[] = [];
	private _stepNames: Set<string> = new Set();
	private _inputSchema?: ZodSchema;
	private _onError?: ErrorHandler;
	private _description?: string;

	constructor(name: string) {
		this._name = name;
	}

	private _assertUniqueStepName(stepName: string): void {
		if (stepName.includes("__")) {
			throw new Error(
				`Workflow "${this._name}": step/loop name "${stepName}" must not contain "__" (reserved for internal namespacing).`,
			);
		}
		if (this._stepNames.has(stepName)) {
			throw new Error(
				`Workflow "${this._name}" already has a step named "${stepName}". Step names must be unique.`,
			);
		}
		this._stepNames.add(stepName);
	}

	/**
	 * Set the input schema for validation.
	 */
	input(schema: ZodSchema): this {
		this._inputSchema = schema;
		return this;
	}

	/**
	 * Add a step to the workflow.
	 *
	 * @param stepInput - Step function or object with fn and config
	 */
	step(stepInput: StepInput): this {
		if (typeof stepInput === "function") {
			// Simple function - derive name from function name
			const name = stepInput.name || `step${this._steps.length + 1}`;
			this._assertUniqueStepName(name);
			this._steps.push({ fn: stepInput, name });
		} else {
			// Object with config
			const { fn, name, timeout, actor, maxAttempts, onTimeout, backoff, onError } = stepInput;
			const stepName = name || fn.name || `step${this._steps.length + 1}`;
			this._assertUniqueStepName(stepName);

			const config: StepConfig = {};
			if (timeout !== undefined) config.timeout = timeout;
			if (actor !== undefined) config.actor = actor;
			if (maxAttempts !== undefined) config.maxAttempts = maxAttempts;
			if (onTimeout !== undefined) config.onTimeout = onTimeout;
			if (backoff !== undefined) config.backoff = backoff;
			if (onError !== undefined) config.onError = onError;

			this._steps.push({
				fn,
				name: stepName,
				config: Object.keys(config).length > 0 ? config : undefined,
			});
		}

		return this;
	}

	/**
	 * Add a forEach loop to the workflow.
	 *
	 * @param name - Unique name for this loop
	 * @param config - Loop configuration (items, do, parallel)
	 */
	forEach(name: string, config: ForEachInput): this {
		if (config.concurrency !== undefined) {
			if (!Number.isInteger(config.concurrency) || config.concurrency < 1) {
				throw new Error(
					`Workflow "${this._name}" loop "${name}" has invalid concurrency ${String(config.concurrency)}. concurrency must be an integer >= 1.`,
				);
			}
			if (!config.parallel) {
				throw new Error(
					`Workflow "${this._name}" loop "${name}" sets concurrency but parallel is not true.`,
				);
			}
		}

		this._assertUniqueStepName(name);
		this._steps.push({
			type: "forEach",
			name,
			items: config.items,
			do: config.do,
			parallel: config.parallel,
			concurrency: config.concurrency,
		});
		return this;
	}

	/**
	 * Set a workflow-level error handler.
	 */
	onError(handler: ErrorHandler): this {
		this._onError = handler;
		return this;
	}

	/**
	 * Set a description for the workflow.
	 */
	description(desc: string): this {
		this._description = desc;
		return this;
	}

	/**
	 * Build the workflow definition.
	 */
	build(): WorkflowDefinition {
		if (this._steps.length === 0) {
			throw new Error(`Workflow "${this._name}" must have at least one step`);
		}

		return {
			name: this._name,
			steps: this._steps,
			inputSchema: this._inputSchema,
			onError: this._onError,
			description: this._description,
		};
	}
}

/**
 * Create a new workflow builder.
 *
 * @param name - Unique name for the workflow
 * @returns A WorkflowBuilder instance for fluent configuration
 *
 * @example
 * ```typescript
 * const workflow = createWorkflow('myWorkflow')
 *   .input(z.object({ userId: z.string() }))
 *   .step(fetchUser)
 *   .step({ fn: processData, timeout: 5000 })
 *   .build();
 * ```
 */
export function createWorkflow(name: string): WorkflowBuilder {
	return new WorkflowBuilder(name);
}
