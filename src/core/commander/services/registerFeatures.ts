import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DzajCommander } from '..';

export const registerFeatures = async (instance: DzajCommander, featuresDir: string) => {
  const getFilesRecursively = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile()).map((file) => join(dir, file.name));
    const folders = entries.filter((entry) => entry.isDirectory());

    const nestedFiles = await Promise.all(folders.map((folder) => getFilesRecursively(join(dir, folder.name))));
    return files.concat(...nestedFiles);
  };

  const files = await getFilesRecursively(featuresDir);

  for (const file of files) {
    try {
      const feature = (await import(file)).default;

      if (typeof feature !== 'function') {
        console.warn(`File ${file} does not export a default function.`);
        continue;
      }

      await feature(instance);
    } catch (error) {
      console.error(`Error executing feature from file ${file}:`, error);
    }
  }
};
