import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { DzajCommand } from '../services';

export const getCommandsMap = async (path: string): Promise<Map<string, Map<string, DzajCommand>>> => {
  const commandsMap = new Map<string, Map<string, DzajCommand>>();

  const traverseDirectory = async (currentPath: string) => {
    const files = readdirSync(currentPath, { withFileTypes: true });

    for (const file of files) {
      const filePath = join(currentPath, file.name);

      if (file.isDirectory()) {
        await traverseDirectory(filePath);
        continue;
      }

      if (!file.name.endsWith('.js') && !file.name.endsWith('.ts')) continue;

      let folderName = basename(currentPath);
      if (folderName.startsWith('[') && folderName.endsWith(']')) {
        folderName = folderName.slice(1, -1);
      }

      const commandName = file.name.replace(/\.(js|ts)$/, '');

      const fileContents = (await import(filePath)).default || (await import(filePath));

      if (!commandsMap.has(folderName)) {
        commandsMap.set(folderName, new Map<string, DzajCommand>());
      }
      commandsMap.get(folderName)!.set(commandName, fileContents);
    }
  };

  await traverseDirectory(path);
  return commandsMap;
};
