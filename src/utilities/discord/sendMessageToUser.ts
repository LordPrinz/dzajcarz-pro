import SendMessageData from "../../types/SendMessageData";

const sendMessageToUser = (data: SendMessageData) => {
	const message = data.message;
	const userId = data.targetId;
	const guild = data.guild;

	guild.members.fetch(userId).then((member) => {
		member.send(message);
	});
};

export default sendMessageToUser;
