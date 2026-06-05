require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const crypto = require('crypto');

const validTokens = new Set();

// ----------------------------------------------------
// 🔐 【認証】
// ----------------------------------------------------
app.http('auth', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const { password, tenant } = await request.json();
            if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };

            const envKey = 'ADMIN_PASSWORD_' + tenant.toUpperCase().replace(/-/g, '_');
            const correctPW = process.env[envKey];
            if (!correctPW) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'このテナントは設定されていません' } };

            const client = new CosmosClient(process.env.COSMOS_CONNECTION);
            const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);

            if (password === correctPW) {
                const token = crypto.randomBytes(16).toString('hex');
                validTokens.add(token);
                setTimeout(() => validTokens.delete(token), 24 * 60 * 60 * 1000);
                // ★ アクセスログ記録（成功）
                await container.items.create({
                    id: crypto.randomUUID(),
                    docType: 'access_log',
                    tenant,
                    result: 'success',
                    ip: request.headers.get('x-forwarded-for') || request.headers.get('client-ip') || 'unknown',
                    createdAt: new Date().toISOString()
                }).catch(() => {});
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { token } };
            }
            // ★ アクセスログ記録（失敗）
            await container.items.create({
                id: crypto.randomUUID(),
                docType: 'access_log',
                tenant,
                result: 'failure',
                ip: request.headers.get('x-forwarded-for') || request.headers.get('client-ip') || 'unknown',
                createdAt: new Date().toISOString()
            }).catch(() => {});
            return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'パスワードが違います' } };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 📅 【期間管理】
// ----------------------------------------------------
app.http('period', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const client = new CosmosClient(process.env.COSMOS_CONNECTION);
            const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);

            if (request.method === 'GET') {
                const tenant = url.searchParams.get('tenant');
                const surveyId = url.searchParams.get('surveyId');
                const id = surveyId ? 'period_survey_' + surveyId : 'period_' + tenant;
                const pk = surveyId ? 'survey_period' : tenant;
                if (!tenant && !surveyId) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant または surveyId は必須です' } };
                try {
                    const { resource } = await container.item(id, pk).read();
                    return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { startDate: resource ? resource.startDate : null, endDate: resource ? resource.endDate : null } };
                } catch (e) {
                    return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { startDate: null, endDate: null } };
                }
            }

            if (request.method === 'POST') {
                const token = request.headers.get('x-admin-token');
                if (!token || !validTokens.has(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
                const body = await request.json().catch(() => ({}));
                const { tenant, surveyId, startDate, endDate } = body;
                const id = surveyId ? 'period_survey_' + surveyId : 'period_' + tenant;
                const pk = surveyId ? 'survey_period' : tenant;
                await container.items.upsert({ id, tenant: pk, startDate: startDate || null, endDate: endDate || null, updatedAt: new Date().toISOString() });
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { status: 'ok', startDate, endDate } };
            }
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 📦 【既存ログ】互換維持
// ----------------------------------------------------
app.http('log', {
    methods: ['POST', 'GET', 'DELETE'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            if (request.method === 'GET' || request.method === 'DELETE') {
                const token = request.headers.get('x-admin-token');
                if (!token || !validTokens.has(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
            }
            const client = new CosmosClient(process.env.COSMOS_CONNECTION);
            const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);

            if (request.method === 'DELETE') {
                const url = new URL(request.url);
                const id = url.searchParams.get('id');
                const tenant = url.searchParams.get('tenant');
                if (!id || !tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'id と tenant は必須です' } };
                await container.item(id, tenant).delete();
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { status: 'deleted' } };
            }

            if (request.method === 'GET') {
                const url = new URL(request.url);
                const tenant = url.searchParams.get('tenant');
                const type = url.searchParams.get('type');
                if (!tenant || !type) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant と type の指定は必須です' } };
                const { resources } = await container.items.query({
                    query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.type = @type",
                    parameters: [{ name: "@tenant", value: tenant }, { name: "@type", value: type }]
                }).fetchAll();
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources };
            }

            const body = await request.json() || {};
            const { tenant, type, data } = body;
            if (!tenant || !type) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant と type は必須です' } };
            await container.items.create({ id: crypto.randomUUID(), tenant, type, ...data, createdAt: new Date().toISOString() });
            return { status: 201, headers: { 'Content-Type': 'application/json' }, jsonBody: { status: 'ok' } };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 📋 【アンケート定義】CRUD
// ----------------------------------------------------
app.http('surveys', {
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const client = new CosmosClient(process.env.COSMOS_CONNECTION);
            const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);

            if (request.method === 'GET') {
                const tenant = url.searchParams.get('tenant');
                const id = url.searchParams.get('id');
                if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };
                if (id) {
                    const { resource } = await container.item(id, tenant).read();
                    return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resource };
                }
                const { resources } = await container.items.query({
                    query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_definition' ORDER BY c.createdAt DESC",
                    parameters: [{ name: "@tenant", value: tenant }]
                }).fetchAll();
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources };
            }

            const token = request.headers.get('x-admin-token');
            if (!token || !validTokens.has(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };

            if (request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const { tenant, title, description, questions, active, thanksMessage } = body;
                if (!tenant || !title) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant と title は必須です' } };
                const newSurvey = {
                    id: 'survey_' + crypto.randomUUID(),
                    docType: 'survey_definition',
                    tenant, title,
                    description: description || '',
                    questions: questions || [],
                    active: active !== undefined ? active : true,
                    thanksMessage: thanksMessage || '',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                await container.items.create(newSurvey);
                return { status: 201, headers: { 'Content-Type': 'application/json' }, jsonBody: newSurvey };
            }

            if (request.method === 'PUT') {
                const body = await request.json().catch(() => ({}));
                const { id, tenant, title, description, questions, active, thanksMessage } = body;
                if (!id || !tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'id と tenant は必須です' } };
                const { resource: existing } = await container.item(id, tenant).read();
                const updated = {
                    ...existing,
                    title: title ?? existing.title,
                    description: description ?? existing.description,
                    questions: questions ?? existing.questions,
                    active: active !== undefined ? active : existing.active,
                    thanksMessage: thanksMessage !== undefined ? thanksMessage : (existing.thanksMessage || ''),
                    updatedAt: new Date().toISOString()
                };
                await container.items.upsert(updated);
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: updated };
            }

            if (request.method === 'DELETE') {
                const id = url.searchParams.get('id');
                const tenant = url.searchParams.get('tenant');
                if (!id || !tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'id と tenant は必須です' } };
                await container.item(id, tenant).delete();
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { status: 'deleted' } };
            }

        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 💬 【回答データ】
// ----------------------------------------------------
app.http('response', {
    methods: ['GET', 'POST', 'DELETE'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const client = new CosmosClient(process.env.COSMOS_CONNECTION);
            const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);

            if (request.method === 'GET' || request.method === 'DELETE') {
                const token = request.headers.get('x-admin-token');
                if (!token || !validTokens.has(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
            }

            if (request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const { surveyId, tenant, answers } = body;
                if (!surveyId || !tenant || !answers) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'surveyId, tenant, answers は必須です' } };
                await container.items.create({ id: crypto.randomUUID(), docType: 'survey_response', surveyId, tenant, answers, createdAt: new Date().toISOString() });
                return { status: 201, headers: { 'Content-Type': 'application/json' }, jsonBody: { status: 'ok' } };
            }

            if (request.method === 'GET') {
                const surveyId = url.searchParams.get('surveyId');
                const tenant = url.searchParams.get('tenant');
                if (!surveyId || !tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'surveyId と tenant は必須です' } };
                const { resources } = await container.items.query({
                    query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.surveyId = @surveyId AND c.docType = 'survey_response' ORDER BY c.createdAt DESC",
                    parameters: [{ name: "@tenant", value: tenant }, { name: "@surveyId", value: surveyId }]
                }).fetchAll();
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources };
            }

            if (request.method === 'DELETE') {
                const id = url.searchParams.get('id');
                const tenant = url.searchParams.get('tenant');
                if (!id || !tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'id と tenant は必須です' } };
                await container.item(id, tenant).delete();
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { status: 'deleted' } };
            }

        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 📊 【アクセスログ】取得
// ----------------------------------------------------
app.http('accesslog', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!token || !validTokens.has(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };

            const client = new CosmosClient(process.env.COSMOS_CONNECTION);
            const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
            const url = new URL(request.url);
            const tenant = url.searchParams.get('tenant');

            let query = "SELECT TOP 200 * FROM c WHERE c.docType = 'access_log' ORDER BY c.createdAt DESC";
            let parameters = [];
            if (tenant) {
                query = "SELECT TOP 200 * FROM c WHERE c.docType = 'access_log' AND c.tenant = @tenant ORDER BY c.createdAt DESC";
                parameters = [{ name: "@tenant", value: tenant }];
            }
            const { resources } = await container.items.query({ query, parameters }).fetchAll();
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 📊 【回答数サマリー】アンケートIDリストで一括取得
// ----------------------------------------------------
app.http('responsecounts', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!token || !validTokens.has(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };

            const body = await request.json().catch(() => ({}));
            const { tenant, surveyIds } = body;
            if (!tenant || !surveyIds || !surveyIds.length) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant と surveyIds は必須です' } };

            const client = new CosmosClient(process.env.COSMOS_CONNECTION);
            const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);

            const counts = {};
            surveyIds.forEach(id => counts[id] = 0);

            const { resources } = await container.items.query({
                query: "SELECT c.surveyId, COUNT(1) as cnt FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_response' AND ARRAY_CONTAINS(@ids, c.surveyId) GROUP BY c.surveyId",
                parameters: [{ name: "@tenant", value: tenant }, { name: "@ids", value: surveyIds }]
            }).fetchAll();

            resources.forEach(r => { counts[r.surveyId] = r.cnt; });
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: counts };
        } catch (e) {
            // GROUP BYが使えない場合のフォールバック
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: {} };
        }
    }
});
