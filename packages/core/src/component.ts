/**
 * Message components (buttons, select menus) described as plain data. A module attaches rows to a reply
 * and declares the handlers with `defineButton` / `defineSelect`; the Discord adapter in apps/bot turns
 * the data into discord.js components and routes clicks back by `custom_id`.
 *
 * custom_id layout: `<module>:<component>:<owner>:<data>`. `<owner>` is the id of the member who may use
 * the component, `<data>` is small free-form state (page number, category…) and may contain colons.
 */
import type { CommandContext, Reply } from "./command.ts";
import { STATE_KEY_LENGTH } from "./component-state.ts";
import type { ModalSpec } from "./modal.ts";

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

/** A user select menu with a single choice; the handler gets the chosen user id in `ctx.values`. Takes a whole row. */
export interface UserSelectSpec {
  type: "user-select";
  customId: string;
  placeholder?: string;
  disabled?: boolean;
}

export type ComponentSpec = ButtonSpec | LinkButtonSpec | SelectSpec | UserSelectSpec;

/** One action row: up to 5 buttons, or exactly one select menu. */
export type ComponentRow = readonly ComponentSpec[];

export const MAX_CUSTOM_ID = 100;
const MAX_ROWS = 5;
const MAX_BUTTONS_PER_ROW = 5;
/** Discord: a select menu holds at most 25 options. */
export const MAX_SELECT_OPTIONS = 25;
const MAX_LABEL = 80;
const MAX_OPTION_TEXT = 100;
const MAX_PLACEHOLDER = 150;
const MAX_URL = 512;
const LINK_PROTOCOLS = ["http:", "https:", "discord:"];
/** A snowflake has at most 20 digits; reserved when checking that an id can fit. */
const MAX_OWNER_LENGTH = 20;

/**
 * Longest `<module>:<name>:` prefix. The rest of `<module>:<name>:<owner>:<data>` must fit an owner id,
 * its separator and a state store key (`STATE_KEY_LENGTH`), the biggest `<data>` a component can rely on.
 */
export const MAX_COMPONENT_PREFIX = MAX_CUSTOM_ID - MAX_OWNER_LENGTH - 1 - STATE_KEY_LENGTH;

/** Discord's limits, checked before the API refuses the whole message. Throws a descriptive Error. */
export function validateRows(rows: readonly ComponentRow[]): void {
  if (rows.length > MAX_ROWS) throw new Error(`A message holds at most ${MAX_ROWS} component rows`);
  const customIds = new Set<string>();
  rows.forEach((row, index) => {
    const at = `component row ${index + 1}`;
    if (row.length === 0) throw new Error(`${at} is empty`);
    const hasSelect = row.some(
      (component) => component.type === "select" || component.type === "user-select",
    );
    if (hasSelect && row.length > 1) {
      throw new Error(`${at}: a select menu takes a whole row`);
    }
    if (row.length > MAX_BUTTONS_PER_ROW) {
      throw new Error(`${at} holds more than ${MAX_BUTTONS_PER_ROW} buttons`);
    }
    for (const component of row) {
      validateComponent(component, at);
      if (component.type === "link") continue;
      if (customIds.has(component.customId)) {
        throw new Error(`${at}: duplicate custom_id "${component.customId}" in one message`);
      }
      customIds.add(component.customId);
    }
  });
}

function inRange(text: string, min: number, max: number): boolean {
  return text.length >= min && text.length <= max;
}

function validateComponent(component: ComponentSpec, at: string): void {
  if (component.type === "link") {
    validateLinkUrl(component.url, at);
  } else if (!inRange(component.customId, 1, MAX_CUSTOM_ID)) {
    throw new Error(`${at}: custom_id must be 1–${MAX_CUSTOM_ID} characters`);
  }
  if (component.type === "select") {
    validateSelect(component, at);
  } else if (component.type === "user-select") {
    if ((component.placeholder?.length ?? 0) > MAX_PLACEHOLDER) {
      throw new Error(`${at}: select placeholder is longer than ${MAX_PLACEHOLDER} characters`);
    }
  } else if (!inRange(component.label, 1, MAX_LABEL)) {
    throw new Error(`${at}: button label must be 1–${MAX_LABEL} characters`);
  }
}

function validateLinkUrl(url: string, at: string): void {
  if (!URL.canParse(url)) throw new Error(`${at}: invalid link URL "${url}"`);
  if (url.length > MAX_URL) throw new Error(`${at}: link URL is longer than ${MAX_URL} characters`);
  const protocol = new URL(url).protocol;
  if (!LINK_PROTOCOLS.includes(protocol)) {
    throw new Error(`${at}: link URL must start with http:, https: or discord:`);
  }
}

function validateSelect(select: SelectSpec, at: string): void {
  const { options, placeholder } = select;
  if (options.length < 1 || options.length > MAX_SELECT_OPTIONS) {
    throw new Error(`${at}: a select menu needs 1–${MAX_SELECT_OPTIONS} options`);
  }
  if (placeholder !== undefined && placeholder.length > MAX_PLACEHOLDER) {
    throw new Error(`${at}: select placeholder is longer than ${MAX_PLACEHOLDER} characters`);
  }
  const values = new Set<string>();
  for (const option of options) {
    if (!inRange(option.label, 1, MAX_OPTION_TEXT)) {
      throw new Error(`${at}: option label must be 1–${MAX_OPTION_TEXT} characters`);
    }
    if (!inRange(option.value, 1, MAX_OPTION_TEXT)) {
      throw new Error(`${at}: option value must be 1–${MAX_OPTION_TEXT} characters`);
    }
    if ((option.description?.length ?? 0) > MAX_OPTION_TEXT) {
      throw new Error(`${at}: option description is longer than ${MAX_OPTION_TEXT} characters`);
    }
    if (values.has(option.value))
      throw new Error(`${at}: duplicate option value "${option.value}"`);
    values.add(option.value);
  }
  const { minValues = 1, maxValues = 1 } = select;
  if (
    !Number.isInteger(minValues) ||
    !Number.isInteger(maxValues) ||
    minValues < 0 ||
    minValues > MAX_SELECT_OPTIONS ||
    maxValues < 1 ||
    maxValues > MAX_SELECT_OPTIONS
  ) {
    throw new Error(`${at}: minValues must be an integer 0–25 and maxValues an integer 1–25`);
  }
  if (minValues > maxValues || maxValues > options.length) {
    throw new Error(`${at}: select minValues/maxValues do not fit its options`);
  }
}

/** What a handler sees. Reuses the identity fields of a command context. */
export interface ComponentContext
  extends Pick<
    CommandContext,
    "user" | "guildId" | "place" | "channelId" | "memberPermissions" | "locale"
  > {
  /** The `<data>` part of the custom_id. */
  readonly state: string;
  /** Chosen option values of a select menu, or the chosen user id of a user select; empty for a button. */
  readonly values: readonly string[];
  /** True once the click got any answer (`update`, `reply` or `defer`). */
  readonly acknowledged: boolean;
  /** Edits the message the component is attached to. `ephemeral` is ignored. */
  update(reply: Reply): Promise<void>;
  /** Acknowledges the click without changing anything yet; a later `update` edits the message. */
  defer(): Promise<void>;
  /** A new message; ephemeral unless the reply says `ephemeral: false`. */
  reply(reply: Reply): Promise<void>;
  /** Opens a modal as the answer to the click (always available). Must be the first answer. */
  showModal(modal: ModalSpec): Promise<void>;
}

export type ComponentKind = "button" | "select" | "user-select";

/**
 * The owner part of the custom_id of a public component (`public: true`): not a member id, so nobody can
 * pass an owner check with it; the dispatcher skips that check for public components only.
 */
export const PUBLIC_OWNER = "*";

interface ComponentDefinition {
  /** Name of the owning module; the registry checks it matches. */
  module: string;
  /** Lowercase letters, digits, - and _ (no colon). Unique within the module. */
  name: string;
  /** Discord permission bits (PermissionFlagsBits) the member needs. Implies guildOnly. */
  permissions?: bigint;
  guildOnly?: boolean;
  /**
   * Anyone may use the component, not only the member it was made for (a shared panel in a channel). Build
   * its custom_id with `PUBLIC_OWNER`. The handler must act on the clicker (`ctx.user`), never on the owner.
   */
  public?: boolean;
  run(ctx: ComponentContext): Promise<void>;
}

export interface AnyComponent extends ComponentDefinition {
  kind: ComponentKind;
  /** Builds the custom_id to put on the matching button or select spec. */
  customId(owner: string, data?: string): string;
}

/** `<module>:<name>:<owner>:<data>`; throws when it cannot fit Discord's 100 characters. */
export function makeCustomId(module: string, name: string, owner: string, data = ""): string {
  if (owner === "" || owner.includes(":")) {
    throw new Error(`"${name}": owner must be a non-empty id without ":"`);
  }
  const id = `${module}:${name}:${owner}:${data}`;
  if (id.length > MAX_CUSTOM_ID) {
    throw new Error(
      `custom_id of "${name}" is ${id.length} characters (max ${MAX_CUSTOM_ID}); keep the state in a ComponentStateStore`,
    );
  }
  return id;
}

function build(kind: ComponentKind, definition: ComponentDefinition): AnyComponent {
  return {
    ...definition,
    kind,
    customId: (owner, data) => makeCustomId(definition.module, definition.name, owner, data),
  };
}

export function defineButton(definition: ComponentDefinition): AnyComponent {
  return build("button", definition);
}

export function defineSelect(definition: ComponentDefinition): AnyComponent {
  return build("select", definition);
}

export function defineUserSelect(definition: ComponentDefinition): AnyComponent {
  return build("user-select", definition);
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
