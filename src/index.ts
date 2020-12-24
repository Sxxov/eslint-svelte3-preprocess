import { Worker, parentPort, isMainThread, workerData } from "worker_threads";
import { performance } from "perf_hooks";
import { preprocess as svelteCompilerPreprocess } from "svelte/compiler";
import esTree from "@typescript-eslint/typescript-estree";
import { sveltePreprocess as sveltePreprocessAutoPreprocess } from "svelte-preprocess/dist/autoProcess";
import type {
	AutoPreprocessOptions,
	Markup,
	PreprocessWithPreprocessorsData,
	proprocessFunction,
	Result,
	Script,
	Style,
} from "./types";

let eslintSveltePreprocess: ReturnType<typeof main> | undefined;
let lastResult: Result;
let lastTime = performance.now();

if (isMainThread) {
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
	// `import.meta.url` is needed for esm interop
	// eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error, @typescript-eslint/ban-ts-comment
	// @ts-ignore
	const worker = new Worker(__filename ?? import.meta?.url, {
		workerData: [isDoneView, dataView, dataLengthView],
	});

	eslintSveltePreprocess = main(isDoneView, dataView, dataLengthView, worker);
} else {
	worker();
}

function main(
	isDoneView: Int32Array,
	dataView: Uint8Array,
	dataLengthView: Uint32Array,
	worker: Worker,
) {
	return (autoPreprocessConfig: AutoPreprocessOptions): proprocessFunction => (
		src: string,
		filename: string,
	): Result => {
		let result: Result | undefined;

		console.log("Main:", "Sending request to worker", time());

		worker.postMessage({
			src,
			filename,
			autoPreprocessConfig,
		} as PreprocessWithPreprocessorsData);

		console.log(
			"Main:",
			"Locking thread to wait for response from worker",
			time(),
		);

		const waitResult = Atomics.wait(isDoneView, 0, 0, 5000);

		console.log("Main:", `Worker wait result: ${waitResult}`, time());
		Atomics.store(isDoneView, 0, 0);

		const textDecoder = new TextDecoder();
		const decoded = textDecoder.decode(dataView.subarray(0, dataLengthView[0]));

		try {
			result = JSON.parse(decoded);
		} catch (err) {
			console.log(
				"Main:",
				`Parsing JSON returned an error, returning \`lastResult\``,
				time(),
			);
			console.log(err);

			return lastResult;
		}

		if (result === undefined) {
			console.log(
				"Main:",
				`Result is invalid (${String(result)}), returning \`lastResult\``,
				time(),
			);

			return lastResult;
		}

		console.log("Main:", "Result is valid, returning `result`", time());

		lastResult = result;

		return result;
	};
}

function worker() {
	if (parentPort === null) {
		throw new Error("parentPort is null");
	}

	let result: Result | undefined;

	parentPort.on("message", async (message: PreprocessWithPreprocessorsData) => {
		console.log("Worker: Message:", "Received preprocessors", time());

		try {
			result = await preprocess(message);
			console.log("Worker: Message: Success!", time());
		} catch (err) {
			console.log("Worker: Message: Error:", err, time());
			result = undefined;
		}

		console.log("Worker: Message:", "Writing preprocess result", time());

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

		console.log("Worker: Message:", "Unlocking main thread", time());

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

		// Not clonable
		delete result.toString;

		// Console.log("Worker: Preprocess: Markup:", markup);
		// console.log("Worker: Preprocess: Instance", instance);
		// console.log("Worker: Preprocess: Module:", module);

		return {
			...result,
			instance: instance as Script,
			markup: markup as Markup,
			module: module as Script,
			style: style as Style,
		};
	}
}

function time() {
	const t = performance.now() - lastTime;
	lastTime = performance.now();

	return `${t} -- ${Date.now()}`;
}

module.exports = eslintSveltePreprocess;
export default eslintSveltePreprocess;
