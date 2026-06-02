const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

app.http('log', {
    methods: ['POST', 'GET'], // 💡GET（読み出し）も許可します
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const client = new CosmosClient(process.env.COSMOS_CONNECTION);
            const container = client
                .database(process.env.COSMOS_DATABASE)
                .container(process.env.COSMOS_CONTAINER);

            // ----------------------------------------------------
            // 📊 【GETの場合】管理画面からのデータ読み出し処理
            // ----------------------------------------------------
            if (request.method === 'GET') {
                // URLの?tenant=xxx&type=yyy を取得
                const url = new URL(request.url);
                const tenant = url.searchParams.get('tenant');
                const type = url.searchParams.get('type');

                if (!tenant || !type) {
                    return {
                        status: 400,
                        headers: { 'Content-Type': 'application/json' },
                        jsonBody: { error: 'tenant と type の指定は必須です' }
                    };
                }

                // Cosmos DBから特定のテナントとタイプのデータを検索
                const querySpec = {
                    query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.type = @type",
                    parameters: [
                        { name: "@tenant", value: tenant },
                        { name: "@type", value: type }
                    ]
                };

                const { resources: items } = await container.items.query(querySpec).fetchAll();

                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    jsonBody: items
                };
            }

            // ----------------------------------------------------
            // 📥 【POSTの場合】アンケート画面からのデータ保存処理
            // ----------------------------------------------------
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