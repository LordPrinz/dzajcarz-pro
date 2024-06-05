import {
	ButtonBuilder,
	ComponentType,
	type Interaction,
	type APIButtonComponentWithURL,
	type APIButtonComponentWithCustomId,
} from "discord.js";

type InteractionButtonProps = Omit<
	Omit<APIButtonComponentWithCustomId, "type"> & {
		interaction: Interaction;
	},
	"custom_id"
> & {
	label: string;
};

export const Button = (
	props: InteractionButtonProps | Omit<APIButtonComponentWithURL, "type">
): [ButtonBuilder, string?] => {
	if ("url" in props) {
		const buttonBuilder = new ButtonBuilder({
			type: ComponentType.Button,
			...props,
		});
		return [buttonBuilder];
	} else {
		const { interaction, ...rest } = props as InteractionButtonProps;
		const id = interaction.id + "-" + props.label;
		const buttonBuilder = new ButtonBuilder({
			customId: id,
			type: ComponentType.Button,
			...rest,
		});
		return [buttonBuilder, id];
	}
};
