export function validateConcurrentConfig(
	workflowName: string,
	alias: string,
	config: { steps: unknown[]; continueOn?: "all" | "detached"; onFailure?: "fail" | "collect" },
): void {
	if (!Array.isArray(config.steps) || config.steps.length === 0) {
		throw new Error(
			`Workflow "${workflowName}" concurrent "${alias}" must define at least one step.`,
		);
	}

	if (
		config.continueOn !== undefined &&
		config.continueOn !== "all" &&
		config.continueOn !== "detached"
	) {
		throw new Error(
			`Workflow "${workflowName}" concurrent "${alias}" has invalid continueOn "${String(config.continueOn)}". Allowed values: "all" | "detached".`,
		);
	}

	if (
		config.onFailure !== undefined &&
		config.onFailure !== "fail" &&
		config.onFailure !== "collect"
	) {
		throw new Error(
			`Workflow "${workflowName}" concurrent "${alias}" has invalid onFailure "${String(config.onFailure)}". Allowed values: "fail" | "collect".`,
		);
	}
}

type ConcurrentChildConfig = {
	timeout?: unknown;
	actor?: unknown;
	maxAttempts?: unknown;
	onTimeout?: unknown;
	backoff?: unknown;
	onError?: unknown;
};

const STEP_CONFIG_KEYS = [
	"timeout",
	"actor",
	"maxAttempts",
	"onTimeout",
	"backoff",
	"onError",
] as const;

function hasStepConfigValues(config: ConcurrentChildConfig | undefined): boolean {
	if (!config) return false;
	return STEP_CONFIG_KEYS.some((key) => config[key] !== undefined);
}

export function validateConcurrentWorkflowChildConfig(
	workflowName: string,
	concurrentAlias: string,
	childAlias: string,
	config: ConcurrentChildConfig | undefined,
): void {
	if (!hasStepConfigValues(config)) return;
	throw new Error(
		`Workflow "${workflowName}" concurrent "${concurrentAlias}" step "${childAlias}" uses workflow run with step-only config. Remove timeout/actor/maxAttempts/onTimeout/backoff/onError from this child.`,
	);
}
