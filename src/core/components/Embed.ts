import { EmbedBuilder, type APIEmbed, type EmbedData } from 'discord.js';

type Props = EmbedData | APIEmbed;

export const Embed = (props: Props) => {
  return new EmbedBuilder(props);
};
