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

/** A user select; the value is the user id. */
export interface UserFieldDef extends FieldBase {
  type: "user";
  placeholder?: string;
  /** Preselected user id. */
  defaultValue?: string;
}

export type ModalFieldDef = TextFieldDef | ChannelFieldDef | UserFieldDef;

/** Key = field id inside the modal and key of the typed `values`; order = order on screen. */
export type ModalFieldsDef = Record<string, ModalFieldDef>;

type FieldValue<F extends ModalFieldDef> = F extends { required: false }
  ? string | undefined
  : string;

/** What `run` receives: text, or an id for channel and user selects; `undefined` only for `required: false`. */
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
  channelTypes?: readonly ModalChannelKind[];
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
  } else if (field.type === "channel") {
    for (const kind of field.channelTypes ?? []) {
      if (!CHANNEL_KINDS.includes(kind)) throw new Error(`${at}: unknown channel type "${kind}"`);
    }
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

/** Raw answers of a submit: text for text inputs, a list of ids for selects. */
export type ModalRawValues = Readonly<Record<string, string | readonly string[] | undefined>>;

const SNOWFLAKE = /^\d{1,20}$/;

function first(raw: string | readonly string[] | undefined): string | undefined {
  return typeof raw === "string" ? raw : raw?.[0];
}

/**
 * Checks a submit against the modal's own definition (Discord validates in the client, but the payload
 * is untrusted) and returns the typed values. Throws a UserError with a Polish message on the first problem.
 */
export function parseModalValues<F extends ModalFieldsDef>(
  fields: F,
  raw: ModalRawValues,
): ModalValues<F> {
  const values: Record<string, string | undefined> = {};
  for (const [key, def] of Object.entries(fields)) {
    const required = def.required ?? true;
    const given = raw[key];
    const selected = def.type === "short" || def.type === "paragraph" ? given : first(given);
    const text = typeof selected === "string" ? selected : undefined;
    if (text === undefined || text.trim() === "") {
      if (required) throw new UserError(`Pole „${def.label}” jest wymagane.`);
      values[key] = undefined;
      continue;
    }
    if (def.type === "short" || def.type === "paragraph") {
      checkTextLength(def, text);
    } else if (!SNOWFLAKE.test(text) || (Array.isArray(given) && given.length > 1)) {
      throw new UserError(`Pole „${def.label}” ma nieprawidłową wartość.`);
    }
    values[key] = text;
  }
  return values as ModalValues<F>;
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
          placeholder: def.placeholder,
          required: def.required ?? true,
          minLength: def.type === "short" || def.type === "paragraph" ? def.minLength : undefined,
          maxLength: def.type === "short" || def.type === "paragraph" ? def.maxLength : undefined,
          value: (defaults as Record<string, string | undefined>)[key] ?? def.defaultValue,
          channelTypes: def.type === "channel" ? def.channelTypes : undefined,
        })),
      };
      validateModal(spec);
      return spec;
    },
  };
}
