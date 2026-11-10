import {
  type AnyComponent,
  type CommandSummary,
  type ComponentRow,
  checkAccess,
  createPaginator,
  defineButton,
  defineSelect,
  type Embed,
  type Invocation,
  plural,
  type Reply,
  type SelectOption,
  type Viewer,
} from "@dzajcarz/core";

export interface InstallLinks {
  /** Adds the bot to a server. */
  guild: string;
  /** Adds the bot to the user's account. */
  user: string;
}

export interface HelpDeps {
  /** Every registered command; read when /help runs, so it includes modules registered later. */
  commands: () => readonly CommandSummary[];
  /** The prefix for this guild; null guildId means a DM. */
  prefixFor: (guildId: string | null) => Promise<string>;
  installLinks: InstallLinks;
  /**
   * Whether the bot is a member of the guild. False means the caller reached it through a user install: the
   * bot has no prefix there and no toggles to look up.
   */
  botInGuild: (guildId: string) => boolean;
  /** Module gate: whether `module` is on in this channel (a thread follows its parent channel). */
  moduleEnabled: (guildId: string, channelId: string, module: string) => Promise<boolean>;
}

export const HELP_PAGE_SIZE = 6;
export const BRAND_COLOR = 0xf5a623;

export const COMMAND_NOT_FOUND = (name: string) => `Nie znam komendy \`${name}\`.`;

/** One line of the list: a command, or one subcommand of a command. */
interface Entry {
  usage: string;
  slashUsage: string;
  description: string;
}

interface Section {
  module: string;
  /** Commands the viewer may use, with the subcommands they may use. */
  commands: CommandSummary[];
  entries: Entry[];
}

interface Visibility {
  sections: Section[];
  /** null when the bot has no prefix where the caller is: a user install, or a group DM. */
  prefix: string | null;
}

/** "1 komenda", "2 komendy", "5 komend", "12 komend", "22 komendy". */
export function commandCount(count: number): string {
  return `${count} ${plural(count, "komenda", "komendy", "komend")}`;
}

function allowedHere(command: CommandSummary, viewer: Viewer, userInstall: boolean): boolean {
  const { places, installs } = command.contexts;
  if (!places.includes(viewer.place)) return false;
  return viewer.place !== "guild" || !userInstall || installs.includes("user");
}

function visibleCommands(
  commands: readonly CommandSummary[],
  viewer: Viewer,
  userInstall: boolean,
): CommandSummary[] {
  const visible: CommandSummary[] = [];
  for (const command of commands) {
    if (!allowedHere(command, viewer, userInstall)) continue;
    if (checkAccess({ permissions: command.permissions }, viewer) !== null) continue;
    if (command.subcommands.length === 0) {
      visible.push(command);
      continue;
    }
    const subcommands = command.subcommands.filter(
      (sub) => checkAccess({ permissions: sub.permissions }, viewer) === null,
    );
    if (subcommands.length > 0) visible.push({ ...command, subcommands });
  }
  return visible;
}

function entriesOf(commands: readonly CommandSummary[]): Entry[] {
  return commands.flatMap((command) =>
    command.subcommands.length === 0
      ? [
          {
            usage: command.usage,
            slashUsage: command.slashUsage,
            description: command.description,
          },
        ]
      : command.subcommands.map((sub) => ({
          usage: sub.usage,
          slashUsage: sub.slashUsage,
          description: sub.description,
        })),
  );
}

/** Slash form, plus the prefix form when the bot has a prefix here; each form shows its own options. */
export function syntax(usage: { slash: string; prefix: string }, prefix: string | null): string {
  return prefix === null
    ? `\`/${usage.slash}\``
    : `\`/${usage.slash}\` · \`${prefix}${usage.prefix}\``;
}

export function createHelp(deps: HelpDeps) {
  async function visibility(viewer: Viewer): Promise<Visibility> {
    const { guildId } = viewer;
    // In a server without the bot there is no prefix and no toggle row: Discord only brings slash commands.
    const userInstall = guildId !== null && !deps.botInGuild(guildId);
    // The bot is not a member of a group DM either, so nobody can type a prefix there.
    const noPrefix = userInstall || viewer.place === "private-channel";
    const byModule = Map.groupBy(deps.commands(), (command) => command.module);
    const sections = await Promise.all(
      [...byModule].map(async ([module, commands]): Promise<Section | null> => {
        if (guildId !== null && !userInstall) {
          if (!(await deps.moduleEnabled(guildId, viewer.channelId, module))) return null;
        }
        const visible = visibleCommands(commands, viewer, userInstall);
        return visible.length > 0
          ? { module, commands: visible, entries: entriesOf(visible) }
          : null;
      }),
    );
    return {
      sections: sections.filter((section) => section !== null),
      prefix: noPrefix ? null : await deps.prefixFor(guildId),
    };
  }

  function selectRow(sections: readonly Section[], owner: string, selected?: string): ComponentRow {
    // The registry caps the module count at one select menu (25).
    const options: SelectOption[] = sections.map((section) => ({
      label: section.module,
      value: section.module,
      description: commandCount(section.entries.length),
      default: section.module === selected,
    }));
    return [
      {
        type: "select",
        customId: menu.customId(owner),
        placeholder: "Wybierz kategorię",
        options,
      },
    ];
  }

  async function startPage(
    viewer: Viewer,
    invocation: Invocation = "slash",
  ): Promise<Exclude<Reply, string>> {
    const { sections, prefix } = await visibility(viewer);
    const total = sections.reduce((sum, section) => sum + section.entries.length, 0);
    const how =
      prefix === null
        ? "Komendy działają jako `/nazwa`."
        : `Każda komenda działa jako \`/nazwa\` albo \`${prefix}nazwa\`.`;
    // The hint names the form the viewer just typed.
    const helpForm = invocation === "prefix" && prefix !== null ? prefix : "/";
    const embed: Embed = {
      title: "Komendy Dżajcarza",
      description: `${how} Szczegóły jednej komendy: \`${helpForm}help komenda\`.`,
      color: BRAND_COLOR,
      fields: sections.map((section) => ({
        name: section.module,
        value: commandCount(section.entries.length),
        inline: true,
      })),
      footer: `Razem: ${commandCount(total)}`,
    };
    const installRow: ComponentRow = [
      { type: "link", label: "Dodaj na serwer", url: deps.installLinks.guild },
      { type: "link", label: "Dodaj na konto", url: deps.installLinks.user },
    ];
    return {
      embeds: [embed],
      components: [
        ...(sections.length > 0 ? [selectRow(sections, viewer.user.id)] : []),
        installRow,
      ],
    };
  }

  const pager = createPaginator({
    module: "general",
    name: "help-page",
    async render({ page, data: module, viewer }) {
      const { sections, prefix } = await visibility(viewer);
      const section = sections.find((candidate) => candidate.module === module);
      const entries = section?.entries ?? [];
      const slice = entries.slice(page * HELP_PAGE_SIZE, (page + 1) * HELP_PAGE_SIZE);
      const embed: Embed = {
        title: `Kategoria: ${module}`,
        description:
          slice.length > 0
            ? slice
                .map(
                  (entry) =>
                    `${syntax({ slash: entry.slashUsage, prefix: entry.usage }, prefix)}\n${entry.description}`,
                )
                .join("\n\n")
            : "Brak dostępnych komend w tej kategorii.",
        color: BRAND_COLOR,
      };
      const back: ComponentRow = [
        {
          type: "button",
          customId: home.customId(viewer.user.id),
          label: "Strona główna",
          style: "primary",
        },
      ];
      return {
        embeds: [embed],
        components: [selectRow(sections, viewer.user.id, module), back],
        pageCount: Math.max(1, Math.ceil(entries.length / HELP_PAGE_SIZE)),
      };
    },
  });

  const menu: AnyComponent = defineSelect({
    module: "general",
    name: "help-menu",
    async run(ctx) {
      const [module] = ctx.values;
      if (module === undefined) return;
      await ctx.update(await pager.first(ctx, module));
    },
  });

  const home: AnyComponent = defineButton({
    module: "general",
    name: "help-home",
    async run(ctx) {
      await ctx.update(await startPage(ctx));
    },
  });

  /** `/help <command>`: the command and the subcommands the viewer may use, or undefined. */
  async function find(viewer: Viewer, name: string) {
    const { sections, prefix } = await visibility(viewer);
    const command = sections
      .flatMap((section) => section.commands)
      .find((candidate) => candidate.name === name || candidate.aliases.includes(name));
    return { command, prefix };
  }

  return {
    components: [menu, home, pager.button],
    startPage,
    find,
  };
}
