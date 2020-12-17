import deasync from "deasync";
import { Worker, parentPort, isMainThread, workerData } from "worker_threads";
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

let eslintSveltePreprocess:
	| ReturnType<typeof getEslintSveltePreprocess>
	| undefined;

if (isMainThread) {
	eslintSveltePreprocess = getEslintSveltePreprocess();
} else {
	(async () => newWorker())();
}

function getEslintSveltePreprocess() {
	return (autoPreprocessConfig: AutoPreprocessOptions): proprocessFunction => (
		src: string,
		filename: string,
	): Result => {
		// `import.meta.url` is needed for esm interop
		// eslint-disable-next-line @typescript-eslint/prefer-ts-expect-error, @typescript-eslint/ban-ts-comment
		// @ts-ignore
		const worker = new Worker(__filename ?? import.meta?.url, {
			workerData: {
				src,
				filename,
				autoPreprocessConfig,
			},
		});
		let result: Result | undefined;
		let isDone = false;

		worker.once("message", (message) => {
			result = message as Result;
			isDone = true;
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
				deasync.sleep(SLOW_POLLING_INDIVIDUAL_DURATION_MS);
			}
		}

		void worker.terminate();

		return result as Result;
	};
}

async function newWorker() {
	if (parentPort === null) {
		throw new Error("parentPort is null");
	}

	let result: Result | undefined;

	try {
		result = await preprocess(workerData as PreprocessWithPreprocessorsData);
	} catch (err) {
		console.error(err);
		result = undefined;
	}

	parentPort.postMessage(result);

	async function preprocess({
		src,
		filename,
		autoPreprocessConfig,
	}: PreprocessWithPreprocessorsData): Promise<Result> {
		let markup: Markup | undefined;
		let module: Script | undefined;
		let instance: Script | undefined;
		let style: Style | undefined;

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
