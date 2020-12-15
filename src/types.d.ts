import { sveltePreprocess } from "svelte-preprocess/dist/autoProcess";
import { PreprocessorGroup } from "svelte-preprocess/dist/types";

type AutoPreprocessOptions = Parameters<typeof sveltePreprocess>[0];

type Preprocessors =
	| Readonly<PreprocessorGroup>
	| ReadonlyArray<Readonly<PreprocessorGroup>>;

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

interface PreprocessWithPreprocessorsData {
	src: string;
	filename: string;
	autoPreprocessConfig: AutoPreprocessOptions;
}
