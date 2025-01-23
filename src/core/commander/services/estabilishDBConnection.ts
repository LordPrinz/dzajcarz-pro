import { sql } from 'bun';

export const buildDB = async () => {
  await sql`CREATE TABLE IF NOT EXISTS Server (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      imageURL TEXT,
      prefix VARCHAR(10) DEFAULT '!',
      isPremium BOOLEAN DEFAULT FALSE,
      language VARCHAR(10) DEFAULT 'en'
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Channels (
      id SERIAL PRIMARY KEY,
      serverID INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Events (
      id SERIAL PRIMARY KEY,
      command VARCHAR(255) NOT NULL,
      type VARCHAR(50) NOT NULL,
      time TIMESTAMP,
      channelID INT,
      FOREIGN KEY (channelID) REFERENCES Channels(id) ON DELETE SET NULL
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServerEvents (
      serverID INT NOT NULL,
      eventID INT NOT NULL,
      disabled BOOLEAN DEFAULT FALSE,
      PRIMARY KEY (serverID, eventID),
      FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE,
      FOREIGN KEY (eventID) REFERENCES Events(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS Users (
      id SERIAL PRIMARY KEY,
      birthday DATE,
      isPremium BOOLEAN DEFAULT FALSE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS ServerUsers (
      id SERIAL PRIMARY KEY,
      userID INT NOT NULL,
      serverID INT NOT NULL,
      sanity INT DEFAULT 100,
      credits INT DEFAULT 0,
      isDeleted BOOLEAN DEFAULT FALSE,
      FOREIGN KEY (userID) REFERENCES Users(id) ON DELETE NO ACTION,
      FOREIGN KEY (serverID) REFERENCES Server(id) ON DELETE CASCADE
  );`;

  await sql`CREATE TABLE IF NOT EXISTS UserEvents (
      eventID INT NOT NULL,
      userID INT NOT NULL,
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

  console.log('Database tables created');
};
