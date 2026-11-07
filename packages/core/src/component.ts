/**
 * Message components (buttons, select menus) described as plain data. A module attaches rows to a reply
 * and declares the handlers with `defineButton` / `defineSelect`; the Discord adapter in apps/bot turns
 * the data into discord.js components and routes clicks back by `custom_id`.
 *
 * custom_id layout: `<module>:<component>:<owner>:<data>`. `<owner>` is the id of the member who may use
 * the component, `<data>` is small free-form state (page number, category…) and may contain colons.
 */
import type { CommandContext, Reply } from "./command.ts";

export type ButtonStyle = "primary" | "secondary" | "success" | "danger";

export interface ButtonSpec {
  type: "button";
  customId: string;
  label: string;
  style?: ButtonStyle;
  /** A unicode emoji. */
  emoji?: string;
  disabled?: boolean;
}

/** Opens a URL; Discord never sends a click to the bot, so it has no handler. */
export interface LinkButtonSpec {
  type: "link";
  url: string;
  label: string;
  emoji?: string;
  disabled?: boolean;
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  emoji?: string;
  /** Preselected. */
  default?: boolean;
}

/** A string select menu. It takes a whole row to itself. */
export interface SelectSpec {
  type: "select";
  customId: string;
  placeholder?: string;
  options: SelectOption[];
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
}

export type ComponentSpec = ButtonSpec | LinkButtonSpec | SelectSpec;

/** One action row: up to 5 buttons, or exactly one select menu. */
export type ComponentRow = readonly ComponentSpec[];

export const MAX_CUSTOM_ID = 100;
const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
const MAX_SELECT_OPTIONS = 25;
const MAX_LABEL = 80;
/** A snowflake has at most 20 digits; reserved when checking that an id can fit. */
const MAX_OWNER_LENGTH = 20;

/** Longest `<module>:<name>:` prefix that still leaves room for an owner id and a separator. */
export const MAX_COMPONENT_PREFIX = MAX_CUSTOM_ID - MAX_OWNER_LENGTH - 2;

/** Discord's limits, checked before the API refuses the whole message. Throws a descriptive Error. */
export function validateRows(rows: readonly ComponentRow[]): void {
  if (rows.length > MAX_ROWS) throw new Error(`A message holds at most ${MAX_ROWS} component rows`);
  rows.forEach((row, index) => {
    const at = `component row ${index + 1}`;
    if (row.length === 0) throw new Error(`${at} is empty`);
    const hasSelect = row.some((component) => component.type === "select");
    if (hasSelect && row.length > 1) {
      throw new Error(`${at}: a select menu takes a whole row`);
    }
    if (row.length > MAX_BUTTONS_PER_ROW) {
      throw new Error(`${at} holds more than ${MAX_BUTTONS_PER_ROW} buttons`);
    }
    for (const component of row) validateComponent(component, at);
  });
}

function validateComponent(component: ComponentSpec, at: string): void {
  if (component.type === "link") {
    if (!URL.canParse(component.url)) throw new Error(`${at}: invalid link URL "${component.url}"`);
  } else if (component.customId.length < 1 || component.customId.length > MAX_CUSTOM_ID) {
    throw new Error(`${at}: custom_id must be 1–${MAX_CUSTOM_ID} characters`);
  }
  if (component.type === "select") {
    const { options } = component;
    if (options.length < 1 || options.length > MAX_SELECT_OPTIONS) {
      throw new Error(`${at}: a select menu needs 1–${MAX_SELECT_OPTIONS} options`);
    }
    const { minValues = 1, maxValues = 1 } = component;
    if (minValues > maxValues || maxValues > options.length) {
      throw new Error(`${at}: select minValues/maxValues do not fit its options`);
    }
  } else if (component.label.length < 1 || component.label.length > MAX_LABEL) {
    throw new Error(`${at}: button label must be 1–${MAX_LABEL} characters`);
  }
}

/** What a handler sees. Reuses the identity fields of a command context. */
export interface ComponentContext
  extends Pick<CommandContext, "user" | "guildId" | "channelId" | "memberPermissions"> {
  /** The `<data>` part of the custom_id. */
  readonly state: string;
  /** Chosen option values of a select menu; empty for a button. */
  readonly values: readonly string[];
  /** Edits the message the component is attached to. `ephemeral` is ignored. */
  update(reply: Reply): Promise<void>;
  /** A new message; ephemeral unless the reply says `ephemeral: false`. */
  reply(reply: Reply): Promise<void>;
}

export type ComponentKind = "button" | "select";

interface ComponentDefinition {
  /** Name of the owning module; the registry checks it matches. */
  module: string;
  /** Lowercase letters, digits, - and _ (no colon). Unique within the module. */
  name: string;
  /** Discord permission bits (PermissionFlagsBits) the member needs. Implies guildOnly. */
  permissions?: bigint;
  guildOnly?: boolean;
  run(ctx: ComponentContext): Promise<void>;
}

export interface AnyComponent extends ComponentDefinition {
  kind: ComponentKind;
  /** Builds the custom_id to put on the matching button or select spec. */
  customId(owner: string, data?: string): string;
}

function build(kind: ComponentKind, definition: ComponentDefinition): AnyComponent {
  return {
    ...definition,
    kind,
    customId(owner, data = "") {
      if (owner === "" || owner.includes(":")) {
        throw new Error(`Component "${definition.name}": owner must be a non-empty id without ":"`);
      }
      const id = `${definition.module}:${definition.name}:${owner}:${data}`;
      if (id.length > MAX_CUSTOM_ID) {
        throw new Error(
          `custom_id of "${definition.name}" is ${id.length} characters (max ${MAX_CUSTOM_ID}); keep the state in a ComponentStateStore`,
        );
      }
      return id;
    },
  };
}

export function defineButton(definition: ComponentDefinition): AnyComponent {
  return build("button", definition);
}

export function defineSelect(definition: ComponentDefinition): AnyComponent {
  return build("select", definition);
}

export interface ParsedCustomId {
  module: string;
  name: string;
  owner: string;
  data: string;
}

export function parseCustomId(customId: string): ParsedCustomId | null {
  const parts = customId.split(":");
  if (parts.length < 4) return null;
  const [module, name, owner] = parts as [string, string, string];
  return { module, name, owner, data: parts.slice(3).join(":") };
}
