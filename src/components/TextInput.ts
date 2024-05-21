import {
	TextInputBuilder,
	type TextInputComponentData,
	type APITextInputComponent,
	type ModalSubmitInteraction,
	TextInputStyle,
} from "discord.js";

type Style = { style: "short" | "paragraph" };

type Props = Partial<
	| (Omit<TextInputComponentData, "style"> & Style)
	| (Omit<APITextInputComponent, "style"> & Style)
>;

export const TextInput = ({ style, ...props }: Props) => {
	const alignedStyle =
		style === "short" ? TextInputStyle.Short : TextInputStyle.Paragraph;

	return new TextInputBuilder({ style: alignedStyle, ...props });
};
export const getTextInputValue = (
	interaction: ModalSubmitInteraction,
	customId: string
) => interaction.fields.getTextInputValue(customId);
