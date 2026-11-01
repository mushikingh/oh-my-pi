import { prompt } from "@oh-my-pi/pi-utils";
import type { Tool } from "../../types";
import { toolWireSchema } from "../../utils/schema/wire";
import omittedToolsPrompt from "./prompts/omitted-tools.md" with { type: "text" };
import type { KiroToolSpec } from "./types";

/**
 * Measured against the live runtime in November 2026: 500 small tools and 600 KB catalogs are
 * accepted on Claude and GPT models, while 1.2 MB is rejected as "Input content length exceeds
 * threshold". The byte budget stays under the measured pass and leaves room for the conversation.
 */
export const KIRO_MAX_TOOL_COUNT = 500;
export const KIRO_MAX_TOOL_CATALOG_BYTES = 512 * 1024;

const KIRO_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const OMITTED_NAMES_SHOWN = 12;
const textEncoder = new TextEncoder();

/**
 * Keywords the runtime's tool-spec validator rejects with "Invalid tool use format". They are
 * advisory for the model and omp validates arguments itself, so dropping them changes no behaviour.
 */
const REJECTED_SCHEMA_KEYS = new Set([
	"additionalProperties",
	"pattern",
	"format",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
	"contentEncoding",
	"contentMediaType",
	"$schema",
	"patternProperties",
	"propertyNames",
	"dependentSchemas",
	"dependentRequired",
	"if",
	"then",
	"else",
	"contains",
	"unevaluatedProperties",
	"unevaluatedItems",
	"encrypted",
]);

/** Values of these keys map names to schemas, so a property literally named "format" must survive. */
const SCHEMA_MAP_KEYS = new Set(["properties", "$defs", "definitions"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeSchemaMap(value: unknown): unknown {
	if (!isPlainObject(value)) return sanitizeKiroSchema(value);
	const out: Record<string, unknown> = {};
	for (const [name, child] of Object.entries(value)) out[name] = sanitizeKiroSchema(child);
	return out;
}

/** Strip the keywords the tool-spec validator rejects, everywhere in a schema tree. */
export function sanitizeKiroSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sanitizeKiroSchema);
	if (!isPlainObject(value)) return value;
	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (REJECTED_SCHEMA_KEYS.has(key)) continue;
		if (key === "required" && Array.isArray(child) && child.length === 0) continue;
		out[key] = SCHEMA_MAP_KEYS.has(key) ? sanitizeSchemaMap(child) : sanitizeKiroSchema(child);
	}
	return out;
}

/**
 * The root must be `type: "object"` with no oneOf/anyOf/allOf. Root composition is flattened:
 * allOf keeps its required fields (conjunction), while anyOf/oneOf drop them so that one valid
 * branch still passes. Nested composition is legal and left alone.
 */
export function ensureRootObjectSchema(schema: unknown): Record<string, unknown> {
	const root = isPlainObject(schema) ? schema : {};
	const compositionKeys = ["oneOf", "anyOf", "allOf"] as const;
	if (!compositionKeys.some(key => Array.isArray(root[key])))
		return root.type === "object" ? root : { ...root, type: "object" };
	const {
		oneOf: _oneOf,
		anyOf: _anyOf,
		allOf: _allOf,
		type: _type,
		properties: _properties,
		required: _required,
		...rest
	} = root;
	const properties: Record<string, unknown> = isPlainObject(root.properties) ? { ...root.properties } : {};
	const required = new Set<string>(
		Array.isArray(root.required) ? root.required.filter(item => typeof item === "string") : [],
	);
	for (const key of compositionKeys) {
		const variants = root[key];
		if (!Array.isArray(variants)) continue;
		for (const variant of variants) {
			if (!isPlainObject(variant)) continue;
			if (isPlainObject(variant.properties)) Object.assign(properties, variant.properties);
			if (key === "allOf" && Array.isArray(variant.required)) {
				for (const item of variant.required) if (typeof item === "string") required.add(item);
			}
		}
	}
	return {
		...rest,
		type: "object",
		...(Object.keys(properties).length > 0 ? { properties } : {}),
		...(required.size > 0 ? { required: [...required] } : {}),
	};
}

export interface KiroToolNames {
	/** The wire-safe name for a tool, registered on first use. */
	alias(name: string): string;
	/** The tool's real name for a name the model sent back. */
	restore(wireName: string): string;
}

/**
 * The runtime rejects tool names outside `^[a-zA-Z0-9_-]{1,64}$`, which MCP names routinely break.
 * Other names become a readable prefix plus a hash of the original, kept unique within one request,
 * so tool specs, replayed calls and the response all agree.
 */
export function createKiroToolNames(): KiroToolNames {
	const used = new Set<string>();
	const aliases = new Map<string, string>();
	const originals = new Map<string, string>();
	const pickAlias = (name: string): string => {
		if (KIRO_TOOL_NAME_RE.test(name) && !used.has(name)) return name;
		const prefix = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 55) || "tool";
		for (let salt = 0; ; salt++) {
			const hash = Bun.SHA256.hash(salt === 0 ? name : `${name}#${salt}`, "hex").slice(0, 8);
			const candidate = `${prefix}_${hash}`;
			if (!used.has(candidate)) return candidate;
		}
	};
	return {
		alias(name) {
			const existing = aliases.get(name);
			if (existing) return existing;
			const alias = pickAlias(name);
			used.add(alias);
			aliases.set(name, alias);
			if (alias !== name) originals.set(alias, name);
			return alias;
		},
		restore(wireName) {
			return originals.get(wireName) ?? wireName;
		},
	};
}

export interface KiroToolCatalog {
	tools: KiroToolSpec[];
	/** Tells the model which tools did not fit, or undefined when they all did. */
	omittedNotice?: string;
}

/** Convert tools for the wire, in order, keeping as many as fit the count and byte budget. */
export function convertKiroTools(tools: readonly Tool[], names: KiroToolNames): KiroToolCatalog {
	const kept: KiroToolSpec[] = [];
	const omitted: string[] = [];
	// Start at 2 for the array brackets; each entry below adds its size and a separator.
	let bytes = 2;
	for (const tool of tools) {
		const spec: KiroToolSpec = {
			toolSpecification: {
				name: names.alias(tool.name),
				description: tool.description || `Tool: ${tool.name}`,
				inputSchema: { json: ensureRootObjectSchema(sanitizeKiroSchema(toolWireSchema(tool))) },
			},
		};
		const size = textEncoder.encode(JSON.stringify(spec)).byteLength + 1;
		if (kept.length >= KIRO_MAX_TOOL_COUNT || bytes + size > KIRO_MAX_TOOL_CATALOG_BYTES) {
			omitted.push(tool.name);
			continue;
		}
		kept.push(spec);
		bytes += size;
	}
	if (omitted.length === 0) return { tools: kept };
	const shown = omitted.slice(0, OMITTED_NAMES_SHOWN).join(", ");
	const remainder = omitted.length - OMITTED_NAMES_SHOWN;
	return {
		tools: kept,
		omittedNotice: prompt.render(omittedToolsPrompt, {
			kept: kept.length,
			total: kept.length + omitted.length,
			omitted: remainder > 0 ? `${shown}, and ${remainder} more` : shown,
		}),
	};
}
