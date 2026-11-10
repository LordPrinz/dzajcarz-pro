import { Client, GatewayIntentBits } from 'discord.js';

const { NODE_ENV } = process.env;

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.on('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}!`);
  const deletedCommands = await deleteCommands(client);
  const message = `Deleted ${deletedCommands} commands`;
  console.log(message);
  client.destroy();
  process.exit();
});

if (NODE_ENV === 'development') {
  client.login(process.env.BOT_DEVELOPMENT_TOKEN);
}
if (NODE_ENV === 'production') {
  client.login(process.env.BOT_PRODUCTION_TOKEN);
}

async function deleteCommands(client: Client) {
  const applicationCommands = client.application?.commands;

  if (!applicationCommands) {
    console.error('Application commands not found.');
    return 0;
  }

  let deletedCommands = 0;

  const fetchedGlobalCommands = await applicationCommands.fetch();
  console.log('Fetched Global Commands');

  for (const command of fetchedGlobalCommands.values()) {
    await command.delete();
    deletedCommands++;
    console.log(`Deleted global command: ${command.name}`);
  }

  const guilds = client.guilds.cache;
  console.log('Fetched Guilds');

  // Delete guild-specific commands
  for (const guild of guilds.values()) {
    const guildCommands = await guild.commands.fetch();
    console.log(`Fetched Guild Commands for guild ${guild.name}`);

    for (const command of guildCommands.values()) {
      await command.delete();
      deletedCommands++;
      console.log(`Deleted guild command in ${guild.name}: ${command.name}`);
    }
  }

  return deletedCommands;
}
