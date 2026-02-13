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
 *   .step({ run: processPayment, timeout: 30000 })
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
import { validateForEachConcurrency } from "./for-each-validation";

/**
 * Step input for the builder - either a function or an object with run + config.
 */
export type StepInput =
	| StepFunction
	| {
			run: StepFunction;
			id?: string;
			alias?: string;
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
	/** Optional explicit internal ID */
	id?: string;
	/** Optional explicit user-facing alias key */
	alias?: string;
	/** Step function that returns the items array to iterate over */
	items: StepFunction;
	/** Body: a single step function or a workflow definition */
	run: StepFunction | WorkflowDefinition;
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
	private _aliases: Set<string> = new Set();
	private _ids: Set<string> = new Set();
	private _stepCounter = 0;
	private _loopCounter = 0;
	private _inputSchema?: ZodSchema;
	private _onError?: ErrorHandler;
	private _description?: string;

	constructor(name: string) {
		this._name = name;
	}

	private _validateIdentifier(value: string, label: string): void {
		if (!value.trim()) {
			throw new Error(`Workflow "${this._name}": ${label} must not be empty.`);
		}
		if (value.includes("__")) {
			throw new Error(
				`Workflow "${this._name}": ${label} "${value}" must not contain "__" (reserved for internal namespacing).`,
			);
		}
	}

	private _reserveAlias(baseAlias: string, explicit: boolean): string {
		this._validateIdentifier(baseAlias, "alias");
		if (explicit) {
			if (this._aliases.has(baseAlias)) {
				throw new Error(
					`Workflow "${this._name}" already has an alias "${baseAlias}". Explicit aliases must be unique.`,
				);
			}
			this._aliases.add(baseAlias);
			return baseAlias;
		}

		if (!this._aliases.has(baseAlias)) {
			this._aliases.add(baseAlias);
			return baseAlias;
		}

		let n = 2;
		for (;;) {
			const candidate = `${baseAlias}_${n}`;
			if (!this._aliases.has(candidate)) {
				this._aliases.add(candidate);
				return candidate;
			}
			n += 1;
		}
	}

	private _reserveId(kind: "step" | "loop", explicitId?: string): string {
		if (explicitId !== undefined) {
			this._validateIdentifier(explicitId, "id");
			if (this._ids.has(explicitId)) {
				throw new Error(
					`Workflow "${this._name}" already has an id "${explicitId}". Explicit ids must be unique.`,
				);
			}
			this._ids.add(explicitId);
			return explicitId;
		}

		let candidate: string;
		do {
			if (kind === "step") {
				this._stepCounter += 1;
				candidate = `s${this._stepCounter}`;
			} else {
				this._loopCounter += 1;
				candidate = `l${this._loopCounter}`;
			}
		} while (this._ids.has(candidate));

		this._ids.add(candidate);
		return candidate;
	}

	private _baseStepAlias(fn: StepFunction): string {
		const base = fn.name?.trim() || "step";
		this._validateIdentifier(base, "step function name");
		return base;
	}

	private _buildStepConfig(input: Omit<Exclude<StepInput, StepFunction>, "run" | "id" | "alias">) {
		const { timeout, actor, maxAttempts, onTimeout, backoff, onError } = input;
		const config: StepConfig = {};
		if (timeout !== undefined) config.timeout = timeout;
		if (actor !== undefined) config.actor = actor;
		if (maxAttempts !== undefined) config.maxAttempts = maxAttempts;
		if (onTimeout !== undefined) config.onTimeout = onTimeout;
		if (backoff !== undefined) config.backoff = backoff;
		if (onError !== undefined) config.onError = onError;
		return Object.keys(config).length > 0 ? config : undefined;
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
	 * @param stepInput - Step function or object with run and config
	 */
	step(stepInput: StepInput): this {
		if (typeof stepInput === "function") {
			const id = this._reserveId("step");
			const alias = this._reserveAlias(this._baseStepAlias(stepInput), false);
			this._steps.push({ id, alias, run: stepInput });
			return this;
		}

		const id = this._reserveId("step", stepInput.id);
		const alias = this._reserveAlias(
			stepInput.alias ?? this._baseStepAlias(stepInput.run),
			stepInput.alias !== undefined,
		);
		this._steps.push({
			id,
			alias,
			run: stepInput.run,
			config: this._buildStepConfig(stepInput),
		});
		return this;
	}

	/**
	 * Add a forEach loop to the workflow.
	 *
	 * @param config - Loop configuration (items, run, parallel)
	 */
	forEach(config: ForEachInput): this {
		const id = this._reserveId("loop", config.id);
		const alias = this._reserveAlias(config.alias ?? "forEach", config.alias !== undefined);
		validateForEachConcurrency(this._name, alias, config);

		this._steps.push({
			type: "forEach",
			id,
			alias,
			items: config.items,
			run: config.run,
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
 *   .step({ run: processData, timeout: 5000 })
 *   .build();
 * ```
 */
export function createWorkflow(name: string): WorkflowBuilder {
	return new WorkflowBuilder(name);
}
