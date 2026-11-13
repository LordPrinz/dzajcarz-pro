import type { CommandContext, Embed, Reply } from "./command.ts";
import { type AnyComponent, type ComponentRow, defineButton } from "./component.ts";
import { coreMessages } from "./messages.ts";

export type Viewer = Pick<
  CommandContext,
  "user" | "guildId" | "place" | "channelId" | "memberPermissions" | "locale"
>;

/** One rendered page; the paginator adds the ◀ ▶ row below `components`. */
export interface PageView {
  content?: string;
  embeds?: Embed[];
  components?: ComponentRow[];
  /** At least 1. */
  pageCount: number;
}

export interface PaginatorOptions {
  module: string;
  /** Component name of the ◀ ▶ buttons. */
  name: string;
  /** Discord permission bits needed on every click; implies guildOnly. */
  permissions?: bigint;
  guildOnly?: boolean;
  /**
   * Renders page `page` (0-based, already clamped to `pageCount`) for `viewer`. `data` is whatever
   * `first()` was given, for example a category. It runs again on every click. `data` shares the
   * 100-character custom_id with the module and component names, the owner id and the page number:
   * keep it under `MAX_CUSTOM_ID - module.length - name.length - 28` characters (prefix colons, a
   * 20-digit owner id and up to 4 page digits with their colons), or put the real state in a ComponentStateStore and pass its key.
   */
  render(args: { page: number; data: string; viewer: Viewer }): Promise<PageView> | PageView;
}

export interface Paginator {
  /** Register on `BotModule.components`. */
  button: AnyComponent;
  /** The reply for page 0; hand it to `ctx.reply`. `data` must not contain secrets (it sits in the custom_id). */
  first(viewer: Viewer, data?: string): Promise<Exclude<Reply, string>>;
}

/**
 * Ready-made pagination: a row `◀ | Strona N/M | ▶` (in the viewer's language), the arrows disabled at the ends. Only the member
 * who ran the command can turn pages (the owner check in `executeComponent`).
 */
export function createPaginator({
  module,
  name,
  permissions,
  guildOnly,
  render,
}: PaginatorOptions): Paginator {
  async function view(owner: string, data: string, requested: number, viewer: Viewer) {
    let page = Math.max(0, requested);
    let rendered = await render({ page, data, viewer });
    const last = Math.max(1, rendered.pageCount) - 1;
    if (page > last) {
      // The list shrank since the message was posted.
      page = last;
      rendered = await render({ page, data, viewer });
    }
    const { pageCount, components = [], ...body } = rendered;
    return {
      ...body,
      components: [...components, navigationRow(owner, data, page, Math.max(1, pageCount), viewer)],
    };
  }

  function navigationRow(
    owner: string,
    data: string,
    page: number,
    pageCount: number,
    viewer: Viewer,
  ): ComponentRow {
    const target = (to: number) => button.customId(owner, `${to}:${data}`);
    return [
      {
        type: "button",
        customId: target(page - 1),
        label: "◀",
        style: "secondary",
        disabled: page <= 0,
      },
      {
        type: "button",
        customId: button.customId(owner, "indicator"),
        label: coreMessages(viewer.locale).page(page + 1, pageCount),
        style: "secondary",
        disabled: true,
      },
      {
        type: "button",
        customId: target(page + 1),
        label: "▶",
        style: "secondary",
        disabled: page >= pageCount - 1,
      },
    ];
  }

  const button = defineButton({
    module,
    name,
    permissions,
    guildOnly,
    async run(ctx) {
      const separator = ctx.state.indexOf(":");
      const to = Number(ctx.state.slice(0, separator));
      if (separator < 0 || !Number.isInteger(to)) return;
      const owner = ctx.user.id;
      await ctx.update(await view(owner, ctx.state.slice(separator + 1), to, ctx));
    },
  });

  return {
    button,
    first: (viewer, data = "") => view(viewer.user.id, data, 0, viewer),
  };
}
