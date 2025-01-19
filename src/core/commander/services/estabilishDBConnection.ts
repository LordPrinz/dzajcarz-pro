import postgres from 'postgres';

export const estabilishDBConnection = async (postgreUrl: string) => {
  return postgres(postgreUrl);
};
