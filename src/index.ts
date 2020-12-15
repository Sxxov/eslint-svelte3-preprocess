import { PreprocessorGroup } from "svelte/types/compiler/preprocess";
import deasync from "deasync";
import { Worker, parentPort, isMainThread } from "worker_threads";
import { preprocess as svelteCompilerPreprocess } from "svelte/compiler";
import esTree from "@typescript-eslint/typescript-estree";
import { sveltePreprocess } from "svelte-preprocess/dist/autoProcess";

const FAST_POLLING_INDIVIDUAL_DURATION_MS = 10;
const SLOW_POLLING_INDIVIDUAL_DURATION_MS = 100;
const FAST_POLLING_TOTAL_DURATION_MS = 2000;
const SLOW_POLLING_TOTAL_DURATION_MS = 2000;

type AutoPreprocessOptions = Parameters<typeof sveltePreprocess>[0];

interface Markup {
	original: string;
	result?: string;
	diff?: number;
}

interface Script {
	ast: unknown;
	original: string;
	ext: string;
	result?: string;
	diff?: number;
}
interface Style {
	original: string;
	result?: string;
	diff?: number;
}

interface Result {
	// Custom results
	module: Script;
	instance: Script;
	style: Style;
	markup: Markup;

	// Svelte compiler preprocess results
	code: string;
	dependencies: unknown[];
	toString?: () => string;
}

type proprocessFunction = (src: string, filename: string) => Result;

enum RequestMessageTypes {
	"PREPROCESS_WITH_PREPROCESSORS",
}

enum ResponseMessageTypes {
	"PREPROCESS_RESULT",
}

interface PreprocessWithPreprocessorsData {
	src: string;
	filename: string;
	autoPreprocessConfig: AutoPreprocessOptions;
}

class Message {
	constructor(
		public type: RequestMessageTypes | ResponseMessageTypes,
		public data: unknown,
	) {}
}

type Preprocessors =
	| Readonly<PreprocessorGroup>
	| ReadonlyArray<Readonly<PreprocessorGroup>>;

let eslintSveltePreprocess:
	| ReturnType<typeof getEslintSveltePreprocess>
	| undefined;

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
					result = message.data as Result;
					isDone = true;
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

		worker.removeAllListeners("message");

		return result as Result;
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
				try {
					result = await preprocess(
						message.data as PreprocessWithPreprocessorsData,
					);
				} catch (err) {
					console.error(err);
					result = undefined;
				}

				parentPort?.postMessage(
					new Message(ResponseMessageTypes.PREPROCESS_RESULT, result),
				);
				break;
			default:
		}
	});

	async function preprocess({
		src,
		filename,
		autoPreprocessConfig,
	}: PreprocessWithPreprocessorsData): Promise<Result> {
		const preprocessors = [sveltePreprocess(autoPreprocessConfig)];
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
				...(Array.isArray(preprocessors) ? preprocessors : [preprocessors]),
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
