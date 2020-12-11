import { PreprocessorGroup } from "svelte/types/compiler/preprocess";
import deasync from "deasync";
import { Worker } from "worker_threads";
import {
	Message,
	PreprocesssWithPreprocessorsData,
	RequestMessageTypes,
	ResponseMessageTypes,
} from "./worker/index";

export interface Markup {
	original: string;
	result?: string;
	diff?: number;
}

export interface Script {
	ast: unknown;
	original: string;
	ext: string;
	result?: string;
	diff?: number;
}
export interface Style {
	original: string;
	result?: string;
	diff?: number;
}

export interface Result {
	// Custom results
	module: Script;
	instance: Script;
	style: Style;
	markup: Markup;

	// Svelte compiler preprocess results
	code: string;
	dependencies: unknown[];
	toString: () => string;
}

type proprocessFunction = (src: string, filename: string) => Result;

const worker = new Worker("./worker/index.js");
const eslintSveltePreprocess = (
	preprocessors:
		| Readonly<PreprocessorGroup>
		| ReadonlyArray<Readonly<PreprocessorGroup>>,
): proprocessFunction => (src: string, filename: string): Result => {
	let result: Result | undefined;

	worker.postMessage(
		new Message(RequestMessageTypes.PREPROCESS_WITH_PREPROCESSORS, {
			src,
			filename,
			preprocessors,
		} as PreprocesssWithPreprocessorsData),
	);

	worker.on("message", (message) => {
		switch (message.type) {
			case ResponseMessageTypes.PREPROCESS_RESULT:
				result = message.data as Result;
				break;
			default:
		}
	});

	deasync.loopWhile(() => result === undefined);

	return result as Result;
};

module.exports = eslintSveltePreprocess;
export default eslintSveltePreprocess;
