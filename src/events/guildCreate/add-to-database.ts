import { sql } from 'bun';
import { services } from 'config/bot';
import type { Guild } from 'discord.js';

export default async (guild: Guild) => {
  const id = guild.id;
  const name = guild.name;
  const imageUrl = guild.iconURL();
  const prefix = '!';
  const isPremium = false;
  const language = 'en';

  await sql`INSERT INTO Server (id, name, imageURL, prefix, isPremium, language) VALUES (${id}, ${name}, ${imageUrl}, ${prefix}, ${isPremium}, ${language}) ON CONFLICT DO NOTHING;`;

  for (const service of services) {
    await sql`INSERT INTO ServerServices (serverID, serviceID) VALUES (${id}, ${service}) ON CONFLICT DO NOTHING;`;
  }

  const users = await guild.members.fetch();

  users.forEach(async (user) => {
    const userId = user.id;
    const birthday = null;
    await sql`INSERT INTO Users (id, birthday) VALUES (${userId}, ${birthday}) ON CONFLICT DO NOTHING;`;
    await sql`INSERT INTO ServerUsers (userID, serverID) VALUES (${userId}, ${guild.id}) ON CONFLICT DO NOTHING;`;
  });

  const channels = await guild.channels.fetch();

  channels.forEach(async (channel) => {
    if (!channel) return;
    const chId = channel.id;
    const serverID = channel.guild.id;
    const chName = channel.name;
    const type = channel.type.toString();
    await sql`INSERT INTO Channels (id, serverID, name, type) VALUES (${chId}, ${serverID}, ${chName}, ${type}) ON CONFLICT DO NOTHING;`;
  });
};
