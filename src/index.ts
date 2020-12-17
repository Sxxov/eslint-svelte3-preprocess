import deasync from "deasync";
import { Worker, parentPort, isMainThread } from "worker_threads";
import { preprocess as svelteCompilerPreprocess } from "svelte/compiler";
import esTree from "@typescript-eslint/typescript-estree";
import { sveltePreprocess as sveltePreprocessAutoPreprocess } from "svelte-preprocess/dist/autoProcess";
import {
	AutoPreprocessOptions,
	Markup,
	PreprocessWithPreprocessorsData,
	proprocessFunction,
	Result,
	Script,
	Style,
} from "./types";

const FAST_POLLING_INDIVIDUAL_DURATION_MS = 10;
const SLOW_POLLING_INDIVIDUAL_DURATION_MS = 100;
const FAST_POLLING_TOTAL_DURATION_MS = 2000;
const SLOW_POLLING_TOTAL_DURATION_MS = 2000;

enum RequestMessageTypes {
	"PREPROCESS_WITH_PREPROCESSORS",
}

enum ResponseMessageTypes {
	"PREPROCESS_RESULT",
	"LOG",
}

class Message {
	constructor(
		public type: RequestMessageTypes | ResponseMessageTypes,
		public data: unknown,
	) {}
}

let eslintSveltePreprocess:
	| ReturnType<typeof getEslintSveltePreprocess>
	| undefined;
let lastResult: Result;

if (isMainThread) {
	eslintSveltePreprocess = getEslintSveltePreprocess(
		// `import.meta.url` is needed for esm interop
		// eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error, @typescript-eslint/ban-ts-comment
		// @ts-ignore
		new Worker(__filename ?? import.meta?.url),
	);
} else {
	newWorker();
}

function getEslintSveltePreprocess(worker: Worker) {
	return (autoPreprocessConfig: AutoPreprocessOptions): proprocessFunction => (
		src: string,
		filename: string,
	): Result => {
		let result: Result | undefined;
		let isDone = false;

		console.log("Main:", "Sending request to worker");

		worker.postMessage(
			new Message(RequestMessageTypes.PREPROCESS_WITH_PREPROCESSORS, {
				src,
				filename,
				autoPreprocessConfig,
			} as PreprocessWithPreprocessorsData),
		);

		worker.on("message", (message) => {
			switch (message.type) {
				case ResponseMessageTypes.PREPROCESS_RESULT:
					console.log("Main:", "Received response from worker");
					result = message.data as Result;
					isDone = true;
					break;
				case ResponseMessageTypes.LOG:
					console.log(message.data as string);
					break;
				default:
			}
		});

		// If timeout at 2000ms, or worker is done
		for (
			let i = 0;
			i <
				FAST_POLLING_TOTAL_DURATION_MS / FAST_POLLING_INDIVIDUAL_DURATION_MS &&
			// eslint-disable-next-line no-unmodified-loop-condition
			!isDone;
			++i
		) {
			console.log(
				"Main:",
				"Polling for response from worker (fast), attempt:",
				i,
			);
			deasync.sleep(FAST_POLLING_INDIVIDUAL_DURATION_MS);
		}

		if (!isDone) {
			// Continue trying for 2000ms at lower ping rate
			for (
				let i = 0;
				i <
					SLOW_POLLING_TOTAL_DURATION_MS /
						SLOW_POLLING_INDIVIDUAL_DURATION_MS &&
				// eslint-disable-next-line no-unmodified-loop-condition
				!isDone;
				++i
			) {
				console.log(
					"Main:",
					"Polling for response from worker (slow), attempt:",
					i,
				);
				deasync.sleep(SLOW_POLLING_INDIVIDUAL_DURATION_MS);
			}
		}

		worker.removeAllListeners("message");

		if (result === undefined) {
			console.log("Main:", "Result is undefined, returning `lastResult`");

			return lastResult;
		}

		console.log("Main:", "Result is valid, returning `result`");

		lastResult = result;

		return result;
	};
}

function newWorker() {
	if (parentPort === null) {
		throw new Error("parentPort is null");
	}

	let result: Result | undefined;

	parentPort.on("message", async (message: Message) => {
		switch (message.type) {
			case RequestMessageTypes.PREPROCESS_WITH_PREPROCESSORS:
				log("Worker: Message:", "Received preprocessors");

				try {
					result = await preprocess(
						message.data as PreprocessWithPreprocessorsData,
					);
				} catch (err) {
					log(err);
					result = undefined;
				}

				log("Worker: Message:", "Finished preprocessing");

				parentPort?.postMessage(
					new Message(ResponseMessageTypes.PREPROCESS_RESULT, result),
				);
				break;
			default:
		}
	});

	function log(...things: unknown[]): void {
		const processedThings = things.map((thing) => {
			switch (typeof thing) {
				case "number":
					return String(thing);
				case "string":
					return thing;
				case "object":
					if (thing === null) {
						return "null";
					}

					if (!Number.isNaN(Number((thing as unknown[]).length))) {
						return `[${(thing as unknown[]).join(", ")}]`;
					}

					if (thing instanceof Error) {
						return `${thing.name}: ${thing.message}\n${thing.stack ?? ""}`;
					}

					break;
				default:
			}

			return String(undefined);
		});
		parentPort?.postMessage(
			new Message(ResponseMessageTypes.LOG, processedThings.join(" ")),
		);
	}

	async function preprocess({
		src,
		filename,
		autoPreprocessConfig,
	}: PreprocessWithPreprocessorsData): Promise<Result> {
		let markup: Markup | undefined;
		let module: Script | undefined;
		let instance: Script | undefined;
		let style: Style | undefined;

		log("Worker: Preprocess:", "Starting preprocess");

		const result: {
			code: string;
			dependencies: string[];
			toString?: () => string;
		} = await svelteCompilerPreprocess(
			src,
			[
				{
					markup: ({ content }) => {
						markup = {
							original: content,
						};

						return {
							code: content,
						};
					},
					script: ({ content, attributes }) => {
						// Supported scenarios
						// type="text/typescript"
						// lang="typescript"
						// lang="ts"
						if (
							attributes.lang === "ts" ||
							attributes.lang === "typescript" ||
							attributes.type === "text/typescript"
						) {
							const ast = esTree.parse(content, { loc: true });

							const obj = {
								ast,
								original: content,
								ext: "ts",
							};

							if (attributes.context) {
								module = obj;
							} else {
								instance = obj;
							}
						}

						return {
							code: content,
						};
					},
					style: ({ content }) => {
						style = {
							original: content,
						};

						return {
							code: content,
						};
					},
				},
				sveltePreprocessAutoPreprocess(autoPreprocessConfig),
				{
					markup: ({ content }) => {
						if (markup) {
							markup.result = content;
							markup.diff = markup.original.length - content.length;
						}

						return {
							code: content,
						};
					},
					script: ({ content, attributes }) => {
						const obj = attributes.context ? module : instance;
						if (obj) {
							obj.result = content;
							obj.diff = obj.original.length - content.length;
						}

						return {
							code: content,
						};
					},
					style: ({ content }) => {
						if (style) {
							style.result = content;
							style.diff = style.original.length - content.length;
						}

						return {
							code: content,
						};
					},
				},
			],
			{ filename: filename || "unknown" },
		);

		log("Worker: Preprocess:", "Gotten result from `svelteCompilerPreprocess`");

		// Not clonable
		delete result.toString;

		return {
			...result,
			instance: instance as Script,
			markup: markup as Markup,
			module: module as Script,
			style: style as Style,
		};
	}
}

module.exports = eslintSveltePreprocess;
export default eslintSveltePreprocess;
