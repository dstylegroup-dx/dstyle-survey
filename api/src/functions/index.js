const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

app.http('log', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            // 💡市川さんが作られた正しい環境変数の値（dstyle-survey と logs）をそのまま使う形に修正しました
            const client = new CosmosClient(process.env.COSMOS_CONNECTION);
            const container = client
                .database(process.env.COSMOS_DATABASE)
                .container(process.env.COSMOS_CONTAINER);

            // リクエストボディの取得
            const body = await request.json() || {};
            const { tenant, type, data } = body;

            if (!tenant || !type) {
                return {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' },
                    jsonBody: { error: 'tenant と type は必須です' }
                };
            }

            // Cosmos DBへ保存
            await container.items.create({
                id: require('crypto').randomUUID(),
                tenant,
                type,
                ...data,
                createdAt: new Date().toISOString()
            });

            return {
                status: 201,
                headers: { 'Content-Type': 'application/json' },
                jsonBody: { status: 'ok' }
            };

        } catch (e) {
            return {
                status: 500,
                headers: { 'Content-Type': 'application/json' },
                jsonBody: { error: e.message }
            };
        }
    }
});