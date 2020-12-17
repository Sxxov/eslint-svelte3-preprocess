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

class Message<T> {
	constructor(
		public type: RequestMessageTypes | ResponseMessageTypes,
		public data: unknown,
	) {}
}

let eslintSveltePreprocess:
	| ReturnType<typeof getEslintSveltePreprocess>
	| undefined;
let lastResult: Result;
let runNumber = 0;

if (isMainThread) {
	eslintSveltePreprocess = getEslintSveltePreprocess(
		// `import.meta.url` is needed for esm interop
		// eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error, @typescript-eslint/ban-ts-comment
		// @ts-ignore
		new Worker(__filename ?? import.meta?.url),
		new SharedArrayBuffer(64 * 1024 * 1024),
		new SharedArrayBuffer(1),
	);
} else {
	newWorker();
}

function getEslintSveltePreprocess(
	worker: Worker,
	resultSharedArrayBuffer: SharedArrayBuffer,
	isDoneSharedArrayBuffer: SharedArrayBuffer,
) {
	return (autoPreprocessConfig: AutoPreprocessOptions): proprocessFunction => (
		src: string,
		filename: string,
	): Result => {
		console.log("Main:", "Run number:", runNumber++);

		const isDone = false;

		console.log("Main:", "Sending request to worker");

		worker.postMessage(
			new Message<PreprocessWithPreprocessorsData>(
				RequestMessageTypes.PREPROCESS_WITH_PREPROCESSORS,
				{
					src,
					filename,
					autoPreprocessConfig,
					resultSharedArrayBuffer,
					isDoneSharedArrayBuffer,
				},
			),
		);

		// Worker.once("message", (message) => {
		// 	switch (message.type) {
		// 		case ResponseMessageTypes.PREPROCESS_RESULT:
		// 			console.log("Main:", "Received response from worker");
		// 			result = message.data as Result;
		// 			isDone = true;
		// 			break;
		// 		default:
		// 	}
		// });

		const resultSharedArrayBufferView = new Uint8Array(resultSharedArrayBuffer);
		const isDoneSharedArrayBufferView = new Uint8Array(isDoneSharedArrayBuffer);

		// If timeout at 2000ms, or worker is done
		for (
			let i = 0;
			i <
				FAST_POLLING_TOTAL_DURATION_MS / FAST_POLLING_INDIVIDUAL_DURATION_MS &&
			!isDoneSharedArrayBufferView[0];
			++i
		) {
			console.log(
				"Main:",
				"Polling for response from worker (fast), attempt:",
				i,
			);
			deasync.runLoopOnce();
			// Deasync.sleep(FAST_POLLING_INDIVIDUAL_DURATION_MS);
		}

		if (!isDone) {
			// Continue trying for 2000ms at lower ping rate
			for (
				let i = 0;
				i <
					SLOW_POLLING_TOTAL_DURATION_MS /
						SLOW_POLLING_INDIVIDUAL_DURATION_MS &&
				!isDoneSharedArrayBufferView[0];
				++i
			) {
				console.log(
					"Main:",
					"Polling for response from worker (slow), attempt:",
					i,
				);
				deasync.runLoopOnce();
				// Deasync.sleep(SLOW_POLLING_INDIVIDUAL_DURATION_MS);
			}
		}

		const textDecoder = new TextDecoder();
		const decodedString = textDecoder.decode(resultSharedArrayBufferView);

		const result = JSON.parse(decodedString) as Result;

		isDoneSharedArrayBufferView[0] = 0;

		// Worker.removeAllListeners("message");

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

	parentPort.on(
		"message",
		async (message: Message<PreprocessWithPreprocessorsData>) => {
			switch (message.type) {
				case RequestMessageTypes.PREPROCESS_WITH_PREPROCESSORS: {
					console.log("Worker: Message:", "Received preprocessors");

					const {
						resultSharedArrayBuffer,
						isDoneSharedArrayBuffer,
					} = message.data as PreprocessWithPreprocessorsData;

					try {
						result = await preprocess(
							message.data as PreprocessWithPreprocessorsData,
						);
					} catch (err) {
						console.log(err);
						result = undefined;
					}

					console.log("Worker: Message:", "Finished preprocessing");

					const resultSharedArrayBufferView = new Uint8Array(
						resultSharedArrayBuffer,
					);
					const isDoneSharedArrayBufferView = new Uint8Array(
						isDoneSharedArrayBuffer,
					);
					const textEncoder = new TextEncoder();

					resultSharedArrayBufferView.set(
						textEncoder.encode(JSON.stringify(result)),
					);
					isDoneSharedArrayBufferView[0] = 1;

					console.log(
						"Worker: Message:",
						"Finished serializing & writing to `resultSharedArrayBuffer`",
					);

					parentPort?.postMessage(
						new Message(ResponseMessageTypes.PREPROCESS_RESULT, result),
					);
					break;
				}

				default:
			}
		},
	);

	async function preprocess({
		src,
		filename,
		autoPreprocessConfig,
	}: PreprocessWithPreprocessorsData): Promise<Result> {
		let markup: Markup | undefined;
		let module: Script | undefined;
		let instance: Script | undefined;
		let style: Style | undefined;

		console.log("Worker: Preprocess:", "Starting preprocess");

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

		console.log(
			"Worker: Preprocess:",
			"Gotten result from `svelteCompilerPreprocess`",
		);

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
