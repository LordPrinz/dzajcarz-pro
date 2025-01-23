import { sql } from 'bun';
import type { Client } from 'discord.js';

export const buildDB = async () => {
  await sql`CREATE TABLE IF NOT EXISTS Server (
      id VARCHAR(18) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      imageURL TEXT,
      prefix VARCHAR(10) DEFAULT '!',
      isPremium BOOLEAN DEFAULT FALSE,
      language VARCHAR(10) DEFAULT 'en'
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Channels (
      id VARCHAR(19) PRIMARY KEY,
      serverID VARCHAR(18) NOT NULL,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(2) NOT NULL,
      FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Events (
      id SERIAL PRIMARY KEY,
      command VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      time TIMESTAMP,
      channelID VARCHAR(19),
      FOREIGN KEY (channelID) REFERENCES Channels(id) ON DELETE SET NULL
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServerEvents (
      serverID VARCHAR(18) NOT NULL,
      eventID INT NOT NULL,
      disabled BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (serverID, eventID),
      FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE,
      FOREIGN KEY (eventID) REFERENCES Events(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Users (
      id VARCHAR(18) PRIMARY KEY,
      birthday DATE,
      isPremium BOOLEAN DEFAULT FALSE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServerUsers (
      id SERIAL PRIMARY KEY,
      userID VARCHAR(18) NOT NULL,
      serverID VARCHAR(18) NOT NULL,
      sanity INT DEFAULT 100,
      credits INT DEFAULT 0,
      isDeleted BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (userID) REFERENCES Users(id) ON DELETE NO ACTION,
      FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS UserEvents (
      eventID INT NOT NULL,
      userID VARCHAR(18) NOT NULL,
      disabled BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (eventID, userID),
      FOREIGN KEY (eventID) REFERENCES Events(id) ON DELETE CASCADE,
      FOREIGN KEY (userID) REFERENCES Users(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Warns (
      id SERIAL PRIMARY KEY,
      message TEXT NOT NULL,
      warnedUserID INT NOT NULL,
      executorUserID INT NOT NULL,
      punishmentSanity INT NOT NULL,
      FOREIGN KEY (warnedUserID) REFERENCES ServerUsers(id) ON DELETE CASCADE,
      FOREIGN KEY (executorUserID) REFERENCES ServerUsers(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Services (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServerServices (
    id SERIAL PRIMARY KEY,
    disabled BOOLEAN DEFAULT FALSE,
    serverID VARCHAR(18) NOT NULL,
    serviceID INT NOT NULL,
    enabled BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE,
    FOREIGN KEY (serviceID) REFERENCES Services(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServiceBlockChannels (
    id SERIAL PRIMARY KEY,
    channelID VARCHAR(19) NOT NULL,
    serviceID INT NOT NULL,
    serverID VARCHAR(18) NOT NULL,
    FOREIGN KEY (channelID) REFERENCES Channels(id) ON DELETE CASCADE,
    FOREIGN KEY (serviceID) REFERENCES Services(id) ON DELETE CASCADE
  );`;

  console.log('Database tables created');
};

export const syncDB = async (client: Client) => {
  const guilds = await client.guilds.fetch();
  guilds.forEach(async (guild) => {
    const id = guild.id;
    const name = guild.name;
    const imageURL = guild.iconURL();
    await sql`INSERT INTO Server (id, name, imageURL) VALUES (${id}, ${name}, ${imageURL}) ON CONFLICT DO NOTHING;`;

    const guildInfoDetalied = await guild.fetch();
    const channels = guildInfoDetalied.channels;

    channels.cache.forEach(async (channel) => {
      const chId = channel.id;
      const serverID = channel.guild.id;
      const chName = channel.name;
      const type = channel.type.toString();
      await sql`INSERT INTO Channels (id, serverID, name, type) VALUES (${chId}, ${serverID}, ${chName}, ${type}) ON CONFLICT DO NOTHING;`;
    });
  });
};
