import {
	APITextInputComponent,
	TextInputBuilder,
	TextInputComponentData,
} from "discord.js";

type Props = Partial<TextInputComponentData | APITextInputComponent>;
export const TextInput = (props: Props) => new TextInputBuilder(props);
