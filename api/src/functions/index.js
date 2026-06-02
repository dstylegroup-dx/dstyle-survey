const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

app.http('log', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            // 💡【重要】環境変数の読み込みとクライアントの作成を、関数の中に引っ越ししました
            // これにより、Azureポータルで設定した「dstyle-survey」と「logs」が確実に100%読み込まれます
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