export const estabilishDBConnection = async ({postgreUrl, redisUrl}: {postgreUrl: string, redisUrl: string}) => {
    
    return {
        DBConnection: {
            url: postgreUrl,
            isConnected: true
        },
        cacheConnection: {
            url: redisUrl,
            isConnected: true
        }
    }
};