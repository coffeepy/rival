/**
 * Logger Factory
 *
 * Creates Pino-style loggers that store logs in actor state.
 */

import type { LogEntry, StepLogger } from "../types";

/**
 * Context for logger creation.
 */
export interface LoggerContext {
	workflowId: string;
	stepName: string;
}

/**
 * Creates a logger that stores entries in the provided array.
 * Also optionally logs to console.
 *
 * @param context - Workflow and step context for log entries
 * @param logStore - Array to store log entries in
 * @param consoleOutput - Whether to also log to console (default: true)
 */
export function createStepLogger(
	context: LoggerContext,
	logStore: LogEntry[],
	consoleOutput = true,
): StepLogger {
	const addEntry = (level: LogEntry["level"], msgOrObj: string | object, optionalMsg?: string) => {
		let message: string;
		let metadata: Record<string, unknown> | undefined;

		if (typeof msgOrObj === "string") {
			message = msgOrObj;
		} else {
			metadata = msgOrObj as Record<string, unknown>;
			message = optionalMsg ?? "";
		}

		const entry: LogEntry = {
			level,
			message,
			timestamp: Date.now(),
			metadata,
		};

		logStore.push(entry);

		if (consoleOutput) {
			const prefix = `[${context.workflowId}/${context.stepName}]`;
			const logFn =
				level === "error"
					? console.error
					: level === "warn"
						? console.warn
						: level === "debug"
							? console.debug
							: console.log;

			if (metadata) {
				logFn(`${prefix} ${message}`, metadata);
			} else {
				logFn(`${prefix} ${message}`);
			}
		}
	};

	return {
		debug(msgOrObj: string | object, optionalMsg?: string) {
			addEntry("debug", msgOrObj, optionalMsg);
		},
		info(msgOrObj: string | object, optionalMsg?: string) {
			addEntry("info", msgOrObj, optionalMsg);
		},
		warn(msgOrObj: string | object, optionalMsg?: string) {
			addEntry("warn", msgOrObj, optionalMsg);
		},
		error(msgOrObj: string | object, optionalMsg?: string) {
			addEntry("error", msgOrObj, optionalMsg);
		},
	};
}
