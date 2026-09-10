/**
 * Validation is delegated to the ecosystem via the Standard Schema spec
 * (standardschema.dev), implemented by Zod, Valibot, ArkType, and others. The
 * framework builds no validator of its own; it only runs a user-provided schema
 * and turns failures into a {@link ValidationError}. Types are inlined (zero-dep);
 * any Standard-Schema value matches structurally.
 */
export interface StandardPathSegment {
  readonly key: PropertyKey;
}

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | StandardPathSegment> | undefined;
}

export type StandardResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

export interface StandardSchemaV1 {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardResult<unknown> | Promise<StandardResult<unknown>>;
    readonly types?: unknown;
  };
}

/** The output type a schema produces on success. */
export type InferOutput<S extends StandardSchemaV1> = S["~standard"]["validate"] extends (
  value: unknown,
) => infer R
  ? Extract<Awaited<R>, { readonly value: unknown }>["value"]
  : never;

export class ValidationError extends Error {
  readonly issues: ReadonlyArray<StandardIssue>;

  constructor(issues: ReadonlyArray<StandardIssue>) {
    super(issues[0]?.message ?? "Validation failed");
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/** Per-route input schemas by source (architecture §5, functional API). */
export interface ValidationSpec {
  readonly body?: StandardSchemaV1;
  readonly query?: StandardSchemaV1;
  readonly params?: StandardSchemaV1;
  readonly headers?: StandardSchemaV1;
}

/** The typed `input` a handler receives, one key per schema present in the spec. */
export type ValidatedInput<V extends ValidationSpec> = {
  readonly [
    K in keyof V as V[K] extends StandardSchemaV1 ? K : never
  ]: V[K] extends StandardSchemaV1 ? InferOutput<V[K]> : never;
};

/**
 * Validate `value` against a Standard Schema, returning the typed output or
 * throwing a {@link ValidationError}. Works with any schema library that
 * implements the spec (sync or async).
 */
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  value: unknown,
): Promise<InferOutput<S>> {
  const result = await schema["~standard"].validate(value);
  if (result.issues !== undefined) {
    throw new ValidationError(result.issues);
  }

  return result.value as InferOutput<S>;
}

/** JSON-safe view of an issue (symbol path keys stringified) for responses. */
export function issueToJson(issue: StandardIssue): {
  message: string;
  path: Array<string | number>;
} {
  const path = (issue.path ?? []).map((segment) => {
    const key = typeof segment === "object" ? segment.key : segment;
    return typeof key === "number" ? key : String(key);
  });

  return { message: issue.message, path };
}
