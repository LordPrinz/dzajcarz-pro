import { ActionRowBuilder, type AnyComponentBuilder } from 'discord.js';

export const ActionRow = <T extends AnyComponentBuilder>(...components: T[]): ActionRowBuilder<T> => new ActionRowBuilder<T>().addComponents(...components);
