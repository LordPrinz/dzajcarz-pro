import { spawn } from 'bun';

const command = process.argv[2].replace('--', '');

const getCommandFile = () => {
  const isSubCommand = command.includes(':');

  if (!isSubCommand) {
    return import.meta.dir + '/' + command + '.sh';
  }

  const [subCommand, mode] = command.split(':');
  return import.meta.dir + '/' + subCommand + '/' + mode + '.sh';
};

const commandFile = getCommandFile();

console.write(`⚡ STARTING: ${commandFile}\n\n`);

spawn(['sh', commandFile], {
  stdio: ['inherit', 'inherit', 'inherit'],
});
