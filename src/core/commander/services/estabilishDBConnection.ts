import { sql } from 'bun';
import { services } from 'config/bot';
import type { Client } from 'discord.js';

export const buildDB = async () => {
  await sql`CREATE TABLE IF NOT EXISTS Server (
      id VARCHAR(20) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      imageURL TEXT,
      prefix VARCHAR(10) DEFAULT '!',
      isPremium BOOLEAN DEFAULT FALSE,
      language VARCHAR(10) DEFAULT 'en'
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Channels (
      id VARCHAR(20) PRIMARY KEY,
      serverID VARCHAR(20) NOT NULL,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(2) NOT NULL,
      FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Events (
      id SERIAL PRIMARY KEY,
      command VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      time TIMESTAMP,
      channelID VARCHAR(20),
      FOREIGN KEY (channelID) REFERENCES Channels(id) ON DELETE SET NULL
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServerEvents (
      serverID VARCHAR(20) NOT NULL,
      eventID INT NOT NULL,
      disabled BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (serverID, eventID),
      FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE,
      FOREIGN KEY (eventID) REFERENCES Events(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Users (
      id VARCHAR(20) PRIMARY KEY,
      birthday DATE,
      isPremium BOOLEAN DEFAULT FALSE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServerUsers (
      id SERIAL PRIMARY KEY,
      userID VARCHAR(20) NOT NULL,
      serverID VARCHAR(20) NOT NULL,
      sanity INT DEFAULT 100,
      credits INT DEFAULT 0,
      isDeleted BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (userID) REFERENCES Users(id) ON DELETE NO ACTION,
      FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS UserEvents (
      eventID INT NOT NULL,
      userID VARCHAR(20) NOT NULL,
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
    id VARCHAR(255) PRIMARY KEY NOT NULL
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServerServices (
    disabled BOOLEAN DEFAULT FALSE,
    serverID VARCHAR(20) NOT NULL,
    serviceID VARCHAR(255) NOT NULL,
    PRIMARY KEY (serverID, serviceID),
    FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE,
    FOREIGN KEY (serviceID) REFERENCES Services(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServiceBlockChannels (
    channelID  VARCHAR(20)  NOT NULL,
    serviceID  VARCHAR(255) NOT NULL,
    serverID   VARCHAR(20)  NOT NULL,
    PRIMARY KEY (channelID, serviceID, serverID),
    FOREIGN KEY (channelID) REFERENCES Channels(id) ON DELETE CASCADE,
    FOREIGN KEY (serviceID) REFERENCES Services(id) ON DELETE CASCADE,
    FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Commands (
    id VARCHAR(255) PRIMARY KEY
  )`;

  await sql`CREATE TABLE IF NOT EXISTS DisabledCommands (
    id SERIAL PRIMARY KEY,
    serverID VARCHAR(20) NOT NULL,
    commandID VARCHAR(255) NOT NULL,
    FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE
    );`;

  await sql`CREATE TABLE IF NOT EXISTS PartyArea (
    categoryID VARCHAR(20),
    serverID VARCHAR(20),
    generationTemplate VARCHAR(255),
    commandChannelId VARCHAR(20) DEFAULT NULL,
    splitChannelId VARCHAR(20) DEFAULT NULL,
    PRIMARY KEY (categoryID, serverID),
    FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE
  );`;

  console.log('Database tables created');
};

export const syncDB = async (client: Client) => {
  const guilds = await client.guilds.fetch();

  services.forEach(async (service) => {
    const serviceName = service;
    await sql`INSERT INTO Services (id) VALUES (${serviceName}) ON CONFLICT DO NOTHING;`;
  });

  guilds.forEach(async (guild) => {
    const id = guild.id;
    const name = guild.name || '';
    const imageURL = guild.iconURL() || '';
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

    const users = await guildInfoDetalied.members.fetch();

    users.forEach(async (user) => {
      const userId = user.id;
      const birthday = null;
      await sql`INSERT INTO Users (id, birthday) VALUES (${userId}, ${birthday}) ON CONFLICT DO NOTHING;`;
      await sql`INSERT INTO ServerUsers (userID, serverID) VALUES (${userId}, ${guild.id}) ON CONFLICT DO NOTHING;`;
    });

    for (const service of services) {
      await sql`
      INSERT INTO ServerServices (serverID, serviceID) 
      VALUES (${guild.id}, ${service})
      ON CONFLICT (serverID, serviceID) DO NOTHING;`;
    }
  });
};
