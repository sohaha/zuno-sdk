import {
  Ajv,
  type AnySchema,
  type ErrorObject,
  type JSONSchemaType,
  type ValidateFunction,
} from "ajv";
import { HarnessError } from "./harness-error.js";

/** {@link ZunoClient.runStructured} 接受的 JSON Schema。 */
export type StructuredOutputSchema<T = unknown> = JSONSchemaType<T> | AnySchema;

/** 归一化后的解析或 JSON Schema 校验问题。 */
export interface StructuredValidationIssue {
  /** 指向非法值的 JSON Pointer 路径。空字符串表示根节点。 */
  path: string;
  /** Ajv 关键字；文本不是合法 JSON 时为 `parse`。 */
  keyword: string;
  /** 可读的校验消息。 */
  message: string;
  /** Ajv 提供的关键字级校验元数据（如有）。 */
  params?: Record<string, unknown>;
}

/** `runStructured` 发起的一次模型尝试。 */
export interface StructuredOutputAttempt {
  /** 从 1 开始的尝试序号。 */
  attempt: number;
  /** 本次尝试产生的原始助手文本。 */
  text: string;
  /** 成功的那次为空。 */
  errors: StructuredValidationIssue[];
}

/** 所有有上限的结构化输出尝试都未通过校验时抛出。 */
export class StructuredOutputError extends HarnessError {
  readonly attempts: StructuredOutputAttempt[];
  readonly validationErrors: StructuredValidationIssue[];
  readonly lastText: string;

  constructor(attempts: StructuredOutputAttempt[]) {
    const last = attempts[attempts.length - 1];
    const count = attempts.length;
    const summary = last?.errors.map(formatIssue).join("; ") || "没有执行任何结构化输出尝试";
    super(
      "structured_output_invalid",
      `模型在 ${count} 次尝试后仍未产出合法的结构化输出：${summary}`,
    );
    this.name = "StructuredOutputError";
    this.attempts = attempts;
    this.validationErrors = last?.errors ?? [];
    this.lastText = last?.text ?? "";
  }
}

const ajv = new Ajv({
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
  strict: false,
  validateSchema: true,
});

export function compileStructuredSchema<T>(schema: StructuredOutputSchema<T>): ValidateFunction<T> {
  try {
    return ajv.compile<T>(schema as AnySchema);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new HarnessError("structured_schema_invalid", message);
  }
}

export type StructuredValidationResult<T> =
  | { ok: true; data: T; errors: [] }
  | { ok: false; data?: undefined; errors: StructuredValidationIssue[] };

export function validateStructuredText<T>(
  text: string,
  validate: ValidateFunction<T>,
): StructuredValidationResult<T> {
  const parsed = parseJsonFromText(text);
  if (!parsed.ok) return { ok: false, errors: [parsed.error] };

  if (validate(parsed.value)) {
    return { ok: true, data: parsed.value as T, errors: [] };
  }

  return { ok: false, errors: normalizeAjvErrors(validate.errors ?? []) };
}

export function buildStructuredPrompt<T>(content: string, schema: StructuredOutputSchema<T>): string {
  return `${content}\n\n${structuredInstructions(schema)}`;
}

export function buildStructuredCorrectionPrompt<T>(
  schema: StructuredOutputSchema<T>,
  attempt: StructuredOutputAttempt,
): string {
  return [
    "你上一次的响应不满足要求的结构化输出约定。",
    "请仅以 JSON 返回更正后的响应，不要 markdown、散文、代码围栏或注释。",
    "它必须通过以下 JSON Schema 校验：",
    "```json",
    stableStringify(schema),
    "```",
    "校验错误：",
    ...attempt.errors.map((issue) => `- ${formatIssue(issue)}`),
    "上一次的响应：",
    "```",
    truncate(attempt.text, 4_000),
    "```",
  ].join("\n");
}

export function assertRetryCount(maxRetries: number): void {
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
    throw new HarnessError("invalid_request", "maxRetries 必须是非负的安全整数");
  }
}

export function formatIssue(issue: StructuredValidationIssue): string {
  const path = issue.path || "/";
  return `${path} ${issue.message}`;
}

function structuredInstructions<T>(schema: StructuredOutputSchema<T>): string {
  return [
    "请仅以 JSON 返回答案，不要 markdown、散文、代码围栏或注释。",
    "JSON 值必须通过以下 JSON Schema 校验：",
    "```json",
    stableStringify(schema),
    "```",
  ].join("\n");
}

function normalizeAjvErrors(errors: ErrorObject[]): StructuredValidationIssue[] {
  return errors.map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message ?? `未通过 ${error.keyword} 校验`,
    params: error.params as Record<string, unknown>,
  }));
}

function parseJsonFromText(text: string):
  | { ok: true; value: unknown }
  | { ok: false; error: StructuredValidationIssue } {
  const candidates = jsonCandidates(text);
  let lastError = "输入为空";
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ok: false,
    error: {
      path: "/",
      keyword: "parse",
      message: `JSON 无效：${lastError}`,
    },
  };
}

function jsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const candidates = [trimmed];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const container = firstJsonContainer(trimmed);
  if (container && !candidates.includes(container)) candidates.push(container);
  return candidates;
}

function firstJsonContainer(text: string): string | undefined {
  const start = text.search(/[\[{]/);
  if (start < 0) return undefined;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return undefined;
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n……已截断 ${value.length - maxChars} 个字符`;
}
