/**
 * Modals (forms) described as plain data. A module declares one with `defineModal`, opens it with
 * `ctx.showModal(modal.build(owner, data))` from a slash command or a component click, and receives the
 * typed answers in `run`. The Discord adapter in apps/bot turns the spec into a modal with Label
 * components and routes the submit back by `custom_id`, exactly like a button click.
 *
 * custom_id layout (same as components): `<module>:<modal>:<owner>:<data>`.
 */

import type { ComponentContext } from "./component.ts";
import { MAX_CUSTOM_ID, makeCustomId } from "./component.ts";
import { UserError } from "./errors.ts";

/** Channel kinds a channel select can be limited to; the adapter maps them to Discord channel types. */
export type ModalChannelKind = "text" | "voice" | "announcement" | "category" | "stage" | "forum";

interface FieldBase {
  /** Shown above the input. */
  label: string;
  /** Smaller text under the label. */
  description?: string;
  /** Default true. An optional field arrives as `undefined` when left empty. */
  required?: boolean;
}

/** A one-line (`short`) or multi-line (`paragraph`) text input. */
export interface TextFieldDef extends FieldBase {
  type: "short" | "paragraph";
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  /** Prefilled text; `build(…, defaults)` can override it per opening. */
  defaultValue?: string;
}

/** A channel select; the value is the channel id. */
export interface ChannelFieldDef extends FieldBase {
  type: "channel";
  channelTypes?: readonly ModalChannelKind[];
  placeholder?: string;
  /** Preselected channel id. */
  defaultValue?: string;
}

/**
 * A user select. With `maxValues` of 1 (the default) the value is the user id; with a larger `maxValues`
 * it is a list of ids (`string[]`). `maxValues` must be a literal in the definition for the type to follow.
 */
export interface UserFieldDef extends FieldBase {
  type: "user";
  placeholder?: string;
  /** Fewest people to pick, 0-25. Default 1 for a required field, 0 for an optional one. */
  minValues?: number;
  /** Most people to pick, 1-25. Default 1. */
  maxValues?: number;
  /** Preselected user id. */
  defaultValue?: string;
}

/** What the handler gets for an uploaded file; the data comes from the attachment Discord resolved. */
export interface ModalFile {
  /** Discord CDN link to the file. */
  url: string;
  name: string;
  /** MIME type as Discord reports it; null when Discord did not detect one. */
  contentType: string | null;
  /** Size in bytes. */
  size: number;
}

/** A single file upload. Discord does not filter by type or size in the client, so both are checked on submit. */
export interface FileFieldDef extends FieldBase {
  type: "file";
  /** Allowed MIME types: exact (`application/pdf`) or a family (`image/*`). Every type when omitted. */
  contentTypes?: readonly string[];
  /** Largest file in bytes. No limit of its own when omitted (Discord's upload limit still applies). */
  maxBytes?: number;
}

/** One choice of a string select. */
export interface ModalSelectOption {
  /** Shown in the list, 1-100 characters. */
  label: string;
  /** What the handler receives, 1-100 characters, unique within the field. */
  value: string;
  description?: string;
}

/** A single-choice string select; the value is the chosen option's `value`. */
export interface SelectFieldDef extends FieldBase {
  type: "select";
  /** 1-25 options. */
  options: readonly ModalSelectOption[];
  placeholder?: string;
  /** `value` of the preselected option. */
  defaultValue?: string;
}

export type ModalFieldDef =
  | TextFieldDef
  | ChannelFieldDef
  | UserFieldDef
  | SelectFieldDef
  | FileFieldDef;

/** Key = field id inside the modal and key of the typed `values`; order = order on screen. */
export type ModalFieldsDef = Record<string, ModalFieldDef>;

type FieldText<F extends ModalFieldDef> = F extends {
  type: "select";
  options: readonly (infer O)[];
}
  ? O extends { value: infer V extends string }
    ? V
    : string
  : F extends { type: "user"; maxValues: infer M extends number }
    ? M extends 1
      ? string
      : string[]
    : F extends { type: "file" }
      ? ModalFile
      : string;

type FieldValue<F extends ModalFieldDef> = F extends { required: false }
  ? FieldText<F> | undefined
  : FieldText<F>;

/**
 * What `run` receives: text, an id for channel and user selects (a list of ids for a user select with
 * `maxValues` above 1), a `ModalFile` for a file upload; `undefined` only for `required: false`.
 */
export type ModalValues<F extends ModalFieldsDef> = { [K in keyof F]: FieldValue<F[K]> };

export interface ModalFieldSpec {
  customId: string;
  type: ModalFieldDef["type"];
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  minLength?: number;
  maxLength?: number;
  /** Prefilled text, or the preselected channel / user id. */
  value?: string;
  /** User select only: how many people may be picked. */
  minValues?: number;
  maxValues?: number;
  channelTypes?: readonly ModalChannelKind[];
  options?: readonly ModalSelectOption[];
}

/** What `ctx.showModal` takes. */
export interface ModalSpec {
  customId: string;
  title: string;
  fields: ModalFieldSpec[];
}

export const MODAL_MAX_FIELDS = 5;
export const MODAL_MAX_TITLE = 45;
export const MODAL_MAX_LABEL = 45;
export const MODAL_MAX_DESCRIPTION = 100;
export const MODAL_MAX_PLACEHOLDER = 100;
export const MODAL_MAX_TEXT = 4000;
export const MODAL_MAX_OPTIONS = 25;
export const MODAL_MAX_OPTION_TEXT = 100;
export const MODAL_MAX_SELECT_VALUES = 25;
const SNOWFLAKE = /^\d{1,20}$/;
const CHANNEL_KINDS: readonly ModalChannelKind[] = [
  "text",
  "voice",
  "announcement",
  "category",
  "stage",
  "forum",
];

/** Discord's limits, checked before the API refuses the modal. Throws a descriptive Error. */
export function validateModal(spec: ModalSpec): void {
  const at = `modal "${spec.title}"`;
  if (spec.customId.length < 1 || spec.customId.length > MAX_CUSTOM_ID) {
    throw new Error(`${at}: custom_id must be 1–${MAX_CUSTOM_ID} characters`);
  }
  if (spec.title.length < 1 || spec.title.length > MODAL_MAX_TITLE) {
    throw new Error(`${at}: title must be 1–${MODAL_MAX_TITLE} characters`);
  }
  if (spec.fields.length < 1 || spec.fields.length > MODAL_MAX_FIELDS) {
    throw new Error(`${at}: needs 1–${MODAL_MAX_FIELDS} fields, got ${spec.fields.length}`);
  }
  const ids = new Set<string>();
  for (const field of spec.fields) {
    validateField(field, `${at}, field "${field.customId}"`);
    if (ids.has(field.customId)) throw new Error(`${at}: duplicate field "${field.customId}"`);
    ids.add(field.customId);
  }
}

function validateField(field: ModalFieldSpec, at: string): void {
  if (field.customId.length < 1 || field.customId.length > MAX_CUSTOM_ID) {
    throw new Error(`${at}: field id must be 1–${MAX_CUSTOM_ID} characters`);
  }
  if (field.label.length < 1 || field.label.length > MODAL_MAX_LABEL) {
    throw new Error(`${at}: label must be 1–${MODAL_MAX_LABEL} characters`);
  }
  if ((field.description?.length ?? 0) > MODAL_MAX_DESCRIPTION) {
    throw new Error(`${at}: description is longer than ${MODAL_MAX_DESCRIPTION} characters`);
  }
  if ((field.placeholder?.length ?? 0) > MODAL_MAX_PLACEHOLDER) {
    throw new Error(`${at}: placeholder is longer than ${MODAL_MAX_PLACEHOLDER} characters`);
  }
  if (field.type === "short" || field.type === "paragraph") {
    validateTextField(field, at);
  } else if (field.type === "select") {
    validateSelectField(field, at);
  } else if (field.type === "file") {
    // Nothing to check: the definition's own limits are enforced on submit.
  } else {
    if (field.type === "user") validateValueCount(field, at);
    if (field.value !== undefined && !SNOWFLAKE.test(field.value)) {
      throw new Error(`${at}: default value must be a channel or user id, got "${field.value}"`);
    }
    if (field.type === "channel") {
      for (const kind of field.channelTypes ?? []) {
        if (!CHANNEL_KINDS.includes(kind)) throw new Error(`${at}: unknown channel type "${kind}"`);
      }
    }
  }
}

function validateValueCount(field: ModalFieldSpec, at: string): void {
  const { minValues, maxValues } = field;
  const inRange = (n: number | undefined, low: number) =>
    n === undefined || (Number.isInteger(n) && n >= low && n <= MODAL_MAX_SELECT_VALUES);
  if (!inRange(minValues, 0) || !inRange(maxValues, 1)) {
    throw new Error(
      `${at}: minValues must be 0–${MODAL_MAX_SELECT_VALUES} and maxValues 1–${MODAL_MAX_SELECT_VALUES}`,
    );
  }
  if (minValues !== undefined && minValues > (maxValues ?? 1)) {
    throw new Error(`${at}: minValues is greater than maxValues`);
  }
  if (field.required && minValues === 0) {
    throw new Error(`${at}: a required field needs minValues of at least 1`);
  }
}

function validateSelectField(field: ModalFieldSpec, at: string): void {
  const options = field.options ?? [];
  if (options.length < 1 || options.length > MODAL_MAX_OPTIONS) {
    throw new Error(`${at}: a select needs 1–${MODAL_MAX_OPTIONS} options, got ${options.length}`);
  }
  const seen = new Set<string>();
  for (const option of options) {
    for (const [name, text] of [
      ["label", option.label],
      ["value", option.value],
    ] as const) {
      if (text.length < 1 || text.length > MODAL_MAX_OPTION_TEXT) {
        throw new Error(`${at}: option ${name} must be 1–${MODAL_MAX_OPTION_TEXT} characters`);
      }
    }
    if ((option.description?.length ?? 0) > MODAL_MAX_DESCRIPTION) {
      throw new Error(
        `${at}: option description is longer than ${MODAL_MAX_DESCRIPTION} characters`,
      );
    }
    if (seen.has(option.value)) throw new Error(`${at}: duplicate option value "${option.value}"`);
    seen.add(option.value);
  }
  if (field.value !== undefined && !seen.has(field.value)) {
    throw new Error(`${at}: default value "${field.value}" is not one of the options`);
  }
}

function validateTextField(field: ModalFieldSpec, at: string): void {
  const { minLength, maxLength, value } = field;
  const lengthOk = (n: number | undefined, low: number) =>
    n === undefined || (Number.isInteger(n) && n >= low && n <= MODAL_MAX_TEXT);
  if (!lengthOk(minLength, 0) || !lengthOk(maxLength, 1)) {
    throw new Error(
      `${at}: minLength must be 0–${MODAL_MAX_TEXT} and maxLength 1–${MODAL_MAX_TEXT}`,
    );
  }
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
    throw new Error(`${at}: minLength is greater than maxLength`);
  }
  if (value !== undefined) {
    if (value.length > (maxLength ?? MODAL_MAX_TEXT)) {
      throw new Error(
        `${at}: default value is longer than ${maxLength ?? MODAL_MAX_TEXT} characters`,
      );
    }
  }
}

/** One raw answer: text, a list of ids (selects), or the files Discord resolved (file upload). */
export type ModalRawValue = string | readonly string[] | readonly ModalFile[] | undefined;

/** Raw answers of a submit: text for text inputs, a list of ids for selects, a list of files for uploads. */
export type ModalRawValues = Readonly<Record<string, ModalRawValue>>;

/**
 * What an adapter puts in a field it refuses (wrong component type, channel or user it did not resolve,
 * wrong channel type, foreign guild). It is not a snowflake, so `parseModalValues` answers it with the
 * "invalid value" message.
 */
export const REJECTED_MODAL_VALUE = "rejected";

function first(raw: ModalRawValue): string | undefined {
  if (typeof raw === "string") return raw;
  const head = raw?.[0];
  return typeof head === "string" ? head : undefined;
}

/** The ids of a select answer; anything that is not a list of strings counts as a forged answer. */
function ids(raw: ModalRawValue): readonly string[] | null {
  if (raw === undefined) return [];
  if (typeof raw === "string") return [raw];
  return raw.every((item) => typeof item === "string") ? (raw as readonly string[]) : null;
}

/**
 * Checks a submit against the modal's own definition (Discord validates in the client, but the payload
 * is untrusted) and returns the typed values. Throws a UserError with a Polish message on the first problem.
 */
export function parseModalValues<F extends ModalFieldsDef>(
  fields: F,
  raw: ModalRawValues,
): ModalValues<F> {
  const values: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(fields)) {
    const required = def.required ?? true;
    const given = raw[key];
    if (def.type === "file") {
      values[key] = parseFile(def, given, required);
    } else if (def.type === "user" && (def.maxValues ?? 1) > 1) {
      values[key] = parseUsers(def, given, required);
    } else {
      values[key] = parseSingle(def, given, required);
    }
  }
  return values as ModalValues<F>;
}

function parseSingle(
  def: Exclude<ModalFieldDef, FileFieldDef>,
  given: ModalRawValue,
  required: boolean,
): string | undefined {
  const isText = def.type === "short" || def.type === "paragraph";
  const selected = isText ? given : first(given);
  // Trimmed once here, so the length limits and the handler see the same text.
  const text = typeof selected === "string" && isText ? selected.trim() : selected;
  if (typeof text !== "string" || text.trim() === "") {
    if (required) throw new UserError(`Pole „${def.label}” jest wymagane.`);
    return undefined;
  }
  if (isText) {
    checkTextLength(def, text);
  } else if (def.type === "select") {
    if (!def.options.some((option) => option.value === text) || oneOf(given)) invalid(def);
  } else if (!SNOWFLAKE.test(text) || oneOf(given)) {
    invalid(def);
  }
  return text;
}

/** A user select that takes several people: a list of distinct ids within `minValues`..`maxValues`. */
function parseUsers(
  def: UserFieldDef,
  given: ModalRawValue,
  required: boolean,
): string[] | undefined {
  const list = ids(given);
  if (list === null) invalid(def);
  const distinct = [...new Set(list)];
  if (distinct.length === 0) {
    if (required) throw new UserError(`Pole „${def.label}” jest wymagane.`);
    return undefined;
  }
  const { minValues = required ? 1 : 0, maxValues = 1 } = def;
  if (!distinct.every((id) => SNOWFLAKE.test(id)) || distinct.length > maxValues) invalid(def);
  if (distinct.length < minValues) {
    throw new UserError(`Pole „${def.label}” wymaga co najmniej ${minValues} wyborów.`);
  }
  return distinct;
}

/** A single upload: the adapter resolved it from the submit; type and size are checked here. */
function parseFile(
  def: FileFieldDef,
  given: ModalRawValue,
  required: boolean,
): ModalFile | undefined {
  if (given === undefined || (Array.isArray(given) && given.length === 0)) {
    if (required) throw new UserError(`Pole „${def.label}” jest wymagane.`);
    return undefined;
  }
  const file = Array.isArray(given) && given.length === 1 ? given[0] : undefined;
  if (!isModalFile(file)) invalid(def);
  if (def.contentTypes && !allowedType(def.contentTypes, file.contentType)) {
    throw new UserError(`Plik w polu „${def.label}” ma niedozwolony typ.`);
  }
  if (def.maxBytes !== undefined && file.size > def.maxBytes) {
    throw new UserError(
      `Plik w polu „${def.label}” może mieć najwyżej ${formatBytes(def.maxBytes)}.`,
    );
  }
  return { url: file.url, name: file.name, contentType: file.contentType, size: file.size };
}

function isModalFile(value: unknown): value is ModalFile {
  if (typeof value !== "object" || value === null) return false;
  const file = value as Record<string, unknown>;
  return (
    typeof file.url === "string" &&
    file.url.startsWith("https://") &&
    typeof file.name === "string" &&
    (file.contentType === null || typeof file.contentType === "string") &&
    typeof file.size === "number" &&
    Number.isFinite(file.size) &&
    file.size >= 0
  );
}

function allowedType(allowed: readonly string[], contentType: string | null): boolean {
  if (contentType === null) return false;
  // "image/png; charset=binary" and "IMAGE/PNG" are the same type.
  const type = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return allowed.some((pattern) => {
    const wanted = pattern.toLowerCase();
    return wanted.endsWith("/*") ? type.startsWith(wanted.slice(0, -1)) : type === wanted;
  });
}

function formatBytes(bytes: number): string {
  return bytes >= 1_048_576
    ? `${Math.round(bytes / 1_048_576)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

/** More than one value submitted to a single-choice select. */
function oneOf(given: ModalRawValue): boolean {
  return Array.isArray(given) && given.length > 1;
}

function invalid(def: ModalFieldDef): never {
  throw new UserError(`Pole „${def.label}” ma nieprawidłową wartość.`);
}

function checkTextLength(def: TextFieldDef, text: string): void {
  const { minLength = 0, maxLength = MODAL_MAX_TEXT } = def;
  if (text.length < minLength || text.length > maxLength) {
    const range = minLength > 0 ? `od ${minLength} do ${maxLength}` : `do ${maxLength}`;
    throw new UserError(`Pole „${def.label}” musi mieć ${range} znaków.`);
  }
}

/** What a modal handler sees. Reuses the identity and answer methods of a component context. */
export interface ModalContext<V = Record<string, string | undefined>>
  extends Pick<
    ComponentContext,
    | "user"
    | "guildId"
    | "place"
    | "channelId"
    | "memberPermissions"
    | "state"
    | "acknowledged"
    | "defer"
    | "reply"
    | "update"
  > {
  /**
   * True when the modal was opened from a message component, so `update` can edit that message. False for a
   * modal opened by a slash command, where `update` throws.
   */
  readonly canUpdate: boolean;
  /** The submitted answers, one per field, already validated against the definition. */
  readonly values: V;
}

/** A modal context before its answers are parsed: what the adapters and fakes build. */
export type ModalBaseContext = Omit<ModalContext, "values">;

export interface ModalDefinition<F extends ModalFieldsDef> {
  /** Name of the owning module; the registry checks it matches. */
  module: string;
  /** Lowercase letters, digits, - and _ (no colon). Unique among the module's modals. */
  name: string;
  /** Window title, up to 45 characters. */
  title: string;
  /** 1–5 fields. */
  fields: F;
  /** Discord permission bits (PermissionFlagsBits) the member needs. Implies guildOnly. */
  permissions?: bigint;
  guildOnly?: boolean;
  run(ctx: ModalContext<ModalValues<F>>): Promise<void>;
}

export interface Modal<F extends ModalFieldsDef = ModalFieldsDef> extends ModalDefinition<F> {
  /**
   * The spec to pass to `ctx.showModal`. `owner` is the member who may submit it, `data` is small state
   * returned as `ctx.state`, `defaults` replaces `defaultValue` of fields for this opening.
   */
  build(
    owner: string,
    data?: string,
    defaults?: Partial<Record<keyof F & string, string>>,
  ): ModalSpec;
}

/** Type-erased modal, as stored on a module. */
export type AnyModal = Modal;

export function defineModal<const F extends ModalFieldsDef>(
  definition: ModalDefinition<F>,
): Modal<F> {
  return {
    ...definition,
    build(owner, data, defaults = {}) {
      const spec: ModalSpec = {
        customId: makeCustomId(definition.module, definition.name, owner, data),
        title: definition.title,
        fields: Object.entries(definition.fields).map(([key, def]) => ({
          customId: key,
          type: def.type,
          label: def.label,
          description: def.description,
          placeholder: "placeholder" in def ? def.placeholder : undefined,
          required: def.required ?? true,
          minLength: def.type === "short" || def.type === "paragraph" ? def.minLength : undefined,
          maxLength: def.type === "short" || def.type === "paragraph" ? def.maxLength : undefined,
          value:
            (defaults as Record<string, string | undefined>)[key] ??
            (def.type === "file" ? undefined : def.defaultValue),
          minValues: def.type === "user" ? def.minValues : undefined,
          maxValues: def.type === "user" ? def.maxValues : undefined,
          channelTypes: def.type === "channel" ? def.channelTypes : undefined,
          options: def.type === "select" ? def.options : undefined,
        })),
      };
      validateModal(spec);
      return spec;
    },
  };
}
