import { appendFileSync } from 'node:fs';

class Logger {
  private logFilePath: string;

  constructor(logFileName: string = 'app.log') {
    this.logFilePath = logFileName;
    Bun.write(this.logFilePath, '');
    this.overrideConsole();
  }

  private overrideConsole(): void {
    const originalLog = console.log;
    const originalError = console.error;

    console.log = (...args: any[]): void => {
      const message = this.formatMessage('LOG', args);
      originalLog(...args);
      this.writeToFile(message);
    };

    console.error = (...args: any[]): void => {
      const message = this.formatMessage('ERROR', args);
      originalError(...args);
      this.writeToFile(message);
    };

    console.warn = (...args: any[]): void => {
      const message = this.formatMessage('WARN', args);
      originalError(...args);
      this.writeToFile(message);
    };
  }

  private formatMessage(level: string, args: any[]): string {
    const timestamp = new Date().toISOString();
    const message = args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : arg)).join(' ');
    return `[${timestamp}] [${level}] ${message}\n`;
  }

  private writeToFile(message: string): void {
    appendFileSync(this.logFilePath, message, 'utf-8');
  }
}

export const logger = new Logger();
