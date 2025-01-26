import { dzajcarz } from './app';
import { logger } from './core/logger';

logger.start();

dzajcarz.handleLogin();

if (process.env.NODE_ENV === 'production') {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception thrown', error);
  });
}
