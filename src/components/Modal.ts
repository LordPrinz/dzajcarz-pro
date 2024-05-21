import {
	ModalBuilder,
	type ModalSubmitInteraction,
	type ActionRowBuilder,
	type TextInputBuilder,
} from "discord.js";

type Props = {
	id?: string;
	components?: ActionRowBuilder<TextInputBuilder>[];
	title: string;
};

export const Modal = ({ title, components, id }: Props) => {
	const customId =
		id ||
		`interaction--${title
			.toLowerCase()
			.replace(/ /g, "_")}${crypto.randomUUID()}`;

	const modal = new ModalBuilder({ customId, title, components });

	const filter = (interaction: ModalSubmitInteraction) =>
		interaction.customId === customId;

	return { Modal: modal, filter };
};
