import postgres from 'postgres';
import { createClient } from 'redis';

export const estabilishDBConnection = async (postgreUrl: string) => {
  return postgres(postgreUrl);
};
