import { PreprocessorGroup } from "svelte/types/compiler/preprocess";
import { parentPort } from "worker_threads";
import { preprocess as sveltePreprocess } from "svelte/compiler";
import esTree from "@typescript-eslint/typescript-estree";
import { Result, Markup, Script, Style } from "../index";

export enum RequestMessageTypes {
	"PREPROCESS_WITH_PREPROCESSORS",
}

export enum ResponseMessageTypes {
	"PREPROCESS_RESULT",
}

export interface PreprocesssWithPreprocessorsData {
	src: string;
	filename: string;
	preprocessors: Preprocessors;
}

export class Message {
	constructor(
		public type: RequestMessageTypes | ResponseMessageTypes,
		public data: unknown,
	) {}
}

type Preprocessors =
	| Readonly<PreprocessorGroup>
	| ReadonlyArray<Readonly<PreprocessorGroup>>;

if (!parentPort) {
	throw new Error("Worker script cannot be run from main thread.");
}

parentPort.on("message", async (message: Message) => {
	switch (message.type) {
		case RequestMessageTypes.PREPROCESS_WITH_PREPROCESSORS:
			parentPort?.postMessage(
				new Message(
					ResponseMessageTypes.PREPROCESS_RESULT,
					await preprocess(message.data as PreprocesssWithPreprocessorsData),
				),
			);
			break;
		default:
	}
});

async function preprocess({
	src,
	filename,
	preprocessors,
}: PreprocesssWithPreprocessorsData): Promise<Result> {
	let markup: Markup | undefined;
	let module: Script | undefined;
	let instance: Script | undefined;
	let style: Style | undefined;

	const result = await sveltePreprocess(
		src,
		[
			{
				markup: ({ content }) => {
					markup = {
						original: content,
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
				},
				style: ({ content }) => {
					style = {
						original: content,
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
				},
				script: ({ content, attributes }) => {
					const obj = attributes.context ? module : instance;
					if (obj) {
						obj.result = content;
						obj.diff = obj.original.length - content.length;
					}
				},
				style: ({ content }) => {
					if (style) {
						style.result = content;
						style.diff = style.original.length - content.length;
					}
				},
			},
		],
		{ filename: filename || "unknown" },
	);

	return {
		...result,
		instance: instance as Script,
		markup: markup as Markup,
		module: module as Script,
		style: style as Style,
	};
}
