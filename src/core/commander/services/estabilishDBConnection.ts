import { postgres } from 'bun';

export const estabilishDBConnection = async (postgreUrl: string) => {
  return postgres(postgreUrl);
};
