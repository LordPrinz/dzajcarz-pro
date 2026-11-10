import { type ClientEvents } from 'discord.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DzajCommander } from '..';

type EventHandler<K extends keyof ClientEvents> = (...args: ClientEvents[K]) => void;

export const registerEvents = async (instance: DzajCommander, eventsDir: string) => {
  const eventHandlers = new Map<keyof ClientEvents, EventHandler<keyof ClientEvents>[]>();

  const eventFolders = readdirSync(eventsDir, { withFileTypes: true }).filter((dirent) => dirent.isDirectory());

  for (const folder of eventFolders) {
    const eventName = folder.name as keyof ClientEvents;
    const folderPath = join(eventsDir, eventName);

    const eventFiles = readdirSync(folderPath, { withFileTypes: true }).filter((dirent) => dirent.isFile());

    for (const file of eventFiles) {
      const filePath = join(folderPath, file.name);

      const handler = (await import(filePath)).default as EventHandler<typeof eventName>;

      if (typeof handler !== 'function') {
        console.error(`File ${file.name} in event ${eventName} does not export a default function.`);
        continue;
      }

      if (!eventHandlers.has(eventName)) {
        eventHandlers.set(eventName, []);
      }
      eventHandlers.get(eventName)!.push(handler);
    }
  }

  for (const [eventName, handlers] of eventHandlers.entries()) {
    instance.getClient().on(eventName, (...args: ClientEvents[typeof eventName]) => {
      handlers.forEach((handler) => handler(...args));
    });
  }
};
