import { Worker, parentPort, isMainThread, workerData } from "worker_threads";
import { preprocess as svelteCompilerPreprocess } from "svelte/compiler";
import esTree from "@typescript-eslint/typescript-estree";
import { sveltePreprocess as sveltePreprocessAutoPreprocess } from "svelte-preprocess/dist/autoProcess";
import { fileURLToPath } from "url";
import type {
	AutoPreprocessOptions,
	Markup,
	PreprocessWithPreprocessorsData,
	proprocessFunction,
	Result,
	Script,
	Style,
} from "./types";

let lastResult: Result;

if (isMainThread) {
	module.exports = main();
} else {
	worker();
}

function main() {
	// Declaring everything here instead of inside the anon function (`(autoPreprocessConfig) => ...`)
	// gives a huge perf boost for some reason
	// if declared inside, there seems to be a bottleneck messaging the worker, taking up ~300ms
	// this is the same bottleneck of starting a new worker every call
	// without it, it takes mere milliseconds to preprocess everything
	const isDoneBuffer = new SharedArrayBuffer(4);
	const isDoneView = new Int32Array(isDoneBuffer);
	const dataBuffer = new SharedArrayBuffer(50 * 1024 * 1024);
	const dataView = new Uint8Array(dataBuffer);
	const dataLengthBuffer = new SharedArrayBuffer(4);
	const dataLengthView = new Uint32Array(dataLengthBuffer);
	const isRunningOnce = !process.argv.includes("--node-ipc");

	let currentFileLocation = "";

	try {
		currentFileLocation = __filename;
		// `import.meta.url` is needed for esm interop
		// eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error, @typescript-eslint/ban-ts-comment
		// @ts-ignore
		currentFileLocation = fileURLToPath(import.meta?.url);
	} catch (_) {
		//
	}

	let worker: Worker | undefined = getNewWorker();

	return (autoPreprocessConfig: AutoPreprocessOptions): proprocessFunction => (
		src: string,
		filename: string,
	): Result => {
		let result: Result | undefined;

		// In case the worker is killed
		// eg. somehow using ESLint async-ly and running this function again,
		// after finishing the event loop once.
		// finishing an event loop would've triggered the killing of the worker
		if (worker === undefined) {
			worker = getNewWorker();
		}

		console.log("Main:", "Sending request to worker");

		worker.postMessage({
			src,
			filename,
			autoPreprocessConfig,
		} as PreprocessWithPreprocessorsData);

		console.log("Main:", "Locking thread to wait for response from worker");

		const waitResult = Atomics.wait(isDoneView, 0, 0, 5000);

		console.log("Main:", `Worker wait result: ${waitResult}`);
		Atomics.store(isDoneView, 0, 0);

		const textDecoder = new TextDecoder();
		const decoded = textDecoder.decode(dataView.subarray(0, dataLengthView[0]));

		try {
			result = JSON.parse(decoded);

			// It is possible for JSON.parse to return "undefined", eg. in SyntaxErrors
			// so catch that and return a cached result instead of letting ESLint panic
			if (!result) {
				throw new Error(`Result is invalid (${String(result)})`);
			}
		} catch (err) {
			console.log(
				"Main:",
				`Parsing JSON returned an error, returning \`lastResult\``,
			);
			console.log(err);

			return lastResult;
		}

		console.log("Main:", "Result is valid, returning `result`");

		if (isRunningOnce) {
			// Kill worker on next tick if running in CLI
			// prevents it from locking up and lets it exit when the event loop is finished
			setTimeout(async () => {
				await worker?.terminate();

				worker = undefined;
			}, 0);
		}

		lastResult = result;

		return result;
	};

	function getNewWorker() {
		return new Worker(currentFileLocation, {
			workerData: [isDoneView, dataView, dataLengthView, isRunningOnce],
		});
	}
}

function worker() {
	if (parentPort === null) {
		throw new Error("parentPort is null");
	}

	let result: Result | undefined;

	parentPort.on("message", async (message: PreprocessWithPreprocessorsData) => {
		console.log("Worker: Message:", "Received preprocessors");

		try {
			result = await preprocess(message);
			console.log("Worker: Message: Success!");
		} catch (err) {
			console.log("Worker: Message: Error:", err);
			result = undefined;
		}

		console.log("Worker: Message:", "Writing preprocess result");

		const [isDoneView, dataView, dataLengthView]: [
			Int32Array,
			Uint8Array,
			Uint32Array,
		] = workerData;

		const textEncoder = new TextEncoder();
		const encodedResult = textEncoder.encode(
			result === undefined ? "" : JSON.stringify(result),
		);

		dataView.set(encodedResult, 0);
		dataLengthView[0] = encodedResult.length;

		console.log("Worker: Message:", "Unlocking main thread");

		Atomics.store(isDoneView, 0, 1);
		Atomics.notify(isDoneView, 0, Number(Infinity));
	});

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

		return {
			...result,
			instance: instance as Script,
			markup: markup as Markup,
			module: module as Script,
			style: style as Style,
		};
	}
}

export default module.exports;
