require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const crypto = require('crypto');


// ----------------------------------------------------
// 🔒 セキュリティヘッダー共通設定
// ----------------------------------------------------
const SECURITY_HEADERS = {
    'Content-Type': 'application/json',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store'
};

function secureJson(body, status = 200) {
    return { status, headers: SECURITY_HEADERS, jsonBody: body };
}

// ----------------------------------------------------
// 🔑 トークン管理（Cosmos DB永続化）
// ----------------------------------------------------
async function getContainer() {
    const client = new CosmosClient(process.env.COSMOS_CONNECTION);
    return client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
}

async function issueToken(tenant) {
    const container = await getContainer();
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await container.items.upsert({
        id: 'token_' + token,
        docType: 'auth_token',
        tenant,
        token,
        expiresAt
    });
    return token;
}

async function verifyToken(token) {
    if (!token) return false;
    try {
        const container = await getContainer();
        const { resource } = await container.item('token_' + token, 'auth_token').read();
        if (!resource) return false;
        if (new Date(resource.expiresAt) < new Date()) {
            // 期限切れは削除
            await container.item('token_' + token, 'auth_token').delete().catch(() => {});
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

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

            const container = await getContainer();

            if (password === correctPW) {
                const token = await issueToken('auth_token');
                // アクセスログ記録（成功）
                await container.items.create({
                    id: crypto.randomUUID(),
                    docType: 'access_log',
                    tenant,
                    result: 'success',
                    ip: request.headers.get('x-forwarded-for') || request.headers.get('client-ip') || 'unknown',
                    createdAt: new Date().toISOString()
                }).catch(() => {});
                return secureJson({ token });
            }
            // アクセスログ記録（失敗）
            await container.items.create({
                id: crypto.randomUUID(),
                docType: 'access_log',
                tenant,
                result: 'failure',
                ip: request.headers.get('x-forwarded-for') || request.headers.get('client-ip') || 'unknown',
                createdAt: new Date().toISOString()
            }).catch(() => {});
            return secureJson({ error: 'パスワードが違います' }, 401);
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
            const container = await getContainer();

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
                if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
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
                if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
            }
            const container = await getContainer();

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
            const container = await getContainer();

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
            if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };

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
            const container = await getContainer();

            if (request.method === 'GET' || request.method === 'DELETE') {
                const token = request.headers.get('x-admin-token');
                if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
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
            if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };

            const container = await getContainer();
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
// 📊 【回答数サマリー】個別カウント方式（GROUP BY非依存）
// ----------------------------------------------------
app.http('responsecounts', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };

            const body = await request.json().catch(() => ({}));
            const { tenant, surveyIds } = body;
            if (!tenant || !surveyIds || !surveyIds.length) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant と surveyIds は必須です' } };

            const container = await getContainer();
            const counts = {};
            surveyIds.forEach(id => counts[id] = 0);

            // GROUP BYを使わず全回答を取得してJS側でカウント
            const { resources } = await container.items.query({
                query: "SELECT c.surveyId FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_response' AND ARRAY_CONTAINS(@ids, c.surveyId)",
                parameters: [{ name: "@tenant", value: tenant }, { name: "@ids", value: surveyIds }]
            }).fetchAll();

            resources.forEach(r => {
                if (counts[r.surveyId] !== undefined) counts[r.surveyId]++;
            });

            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: counts };
        } catch (e) {
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: {} };
        }
    }
});

// ----------------------------------------------------
// 🎨 【デザイン設定】テナント共通 & アンケートごと
// ----------------------------------------------------
app.http('tenantsettings', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const container = await getContainer();

            if (request.method === 'GET') {
                const tenant = url.searchParams.get('tenant');
                const surveyId = url.searchParams.get('surveyId');
                if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };
                // アンケート個別設定を取得（なければテナント共通設定を返す）
                if (surveyId) {
                    try {
                        const { resource } = await container.item('design_' + surveyId, tenant).read();
                        if (resource) return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { ...resource, _source: 'survey' } };
                    } catch (e) {}
                }
                // テナント共通設定
                try {
                    const { resource } = await container.item('settings_' + tenant, tenant).read();
                    return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { ...(resource || {}), _source: 'tenant' } };
                } catch (e) {
                    return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { _source: 'none' } };
                }
            }

            if (request.method === 'POST') {
                const token = request.headers.get('x-admin-token');
                if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
                const body = await request.json().catch(() => ({}));
                const { tenant, surveyId, logoBase64, logoName, headerColor, bgColor, bgType, privacyText, privacyLinkText, privacyLinkUrl, privacyTextColor, privacyBgColor } = body;
                if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };

                const id = surveyId ? 'design_' + surveyId : 'settings_' + tenant;
                const existing = await container.item(id, tenant).read().then(r => r.resource || {}).catch(() => ({}));
                const updated = {
                    ...existing,
                    id,
                    docType: surveyId ? 'survey_design' : 'tenant_settings',
                    tenant,
                    logoBase64: logoBase64 !== undefined ? logoBase64 : (existing.logoBase64 || ''),
                    logoName: logoName !== undefined ? logoName : (existing.logoName || ''),
                    headerColor: headerColor !== undefined ? headerColor : (existing.headerColor || ''),
                    bgColor: bgColor !== undefined ? bgColor : (existing.bgColor || ''),
                    bgType: bgType !== undefined ? bgType : (existing.bgType || 'solid'),
                    privacyText: privacyText !== undefined ? privacyText : (existing.privacyText || ''),
                    privacyLinkText: privacyLinkText !== undefined ? privacyLinkText : (existing.privacyLinkText || ''),
                    privacyLinkUrl: privacyLinkUrl !== undefined ? privacyLinkUrl : (existing.privacyLinkUrl || ''),
                    privacyTextColor: privacyTextColor !== undefined ? privacyTextColor : (existing.privacyTextColor || ''),
                    privacyBgColor: privacyBgColor !== undefined ? privacyBgColor : (existing.privacyBgColor || ''),
                    updatedAt: new Date().toISOString()
                };
                await container.items.upsert(updated);
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: updated };
            }
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 🔮 【診断】CRUD（複数診断対応）
// ----------------------------------------------------
app.http('diagnosislist', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
            const url = new URL(request.url);
            const tenant = url.searchParams.get('tenant');
            if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };
            const container = await getContainer();
            const { resources } = await container.items.query({
                query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.docType = 'diagnosis' ORDER BY c.updatedAt DESC",
                parameters: [{ name: "@tenant", value: tenant }]
            }).fetchAll();
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

app.http('diagnosis', {
    methods: ['GET', 'POST', 'DELETE'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const container = await getContainer();

            if (request.method === 'GET') {
                const tenant = url.searchParams.get('tenant');
                const diagId = url.searchParams.get('diagId') || url.searchParams.get('id');
                if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };
                if (diagId) {
                    try {
                        const { resource } = await container.item(diagId, tenant).read();
                        return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resource || {} };
                    } catch (e) {
                        return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: {} };
                    }
                }
                // 後方互換：diagId未指定時は最初の診断を返す
                try {
                    const { resources } = await container.items.query({
                        query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.docType = 'diagnosis' ORDER BY c.updatedAt DESC OFFSET 0 LIMIT 1",
                        parameters: [{ name: "@tenant", value: tenant }]
                    }).fetchAll();
                    return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources[0] || { questions: [], results: {} } };
                } catch (e) {
                    return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { questions: [], results: {} } };
                }
            }

            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };

            if (request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const { tenant, diagId, questions, results, title, description } = body;
                if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };
                const id = diagId || ('diag_' + crypto.randomUUID());
                const updated = {
                    ...body,
                    id, diagId: id,
                    docType: 'diagnosis',
                    tenant,
                    title: title || '',
                    description: description || '',
                    questions: questions || [],
                    results: results || {},
                    updatedAt: new Date().toISOString()
                };
                await container.items.upsert(updated);
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: updated };
            }

            if (request.method === 'DELETE') {
                const id = url.searchParams.get('id') || url.searchParams.get('diagId');
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
// 📊 【診断結果ログ】
// ----------------------------------------------------
app.http('diagnosislog', {
    methods: ['POST', 'GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const container = await getContainer();
            if (request.method === 'POST') {
                const body = await request.json().catch(() => ({}));
                const { tenant, resultKey, resultTitle } = body;
                if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };
                await container.items.create({
                    id: crypto.randomUUID(),
                    docType: 'diagnosis_log',
                    tenant, resultKey, resultTitle,
                    createdAt: new Date().toISOString()
                });
                return { status: 201, headers: { 'Content-Type': 'application/json' }, jsonBody: { status: 'ok' } };
            }
            if (request.method === 'GET') {
                const token = request.headers.get('x-admin-token');
                if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
                const url = new URL(request.url);
                const tenant = url.searchParams.get('tenant');
                if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };
                const { resources } = await container.items.query({
                    query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.docType = 'diagnosis_log' ORDER BY c.createdAt DESC OFFSET 0 LIMIT 500",
                    parameters: [{ name: "@tenant", value: tenant }]
                }).fetchAll();
                return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: resources };
            }
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// ⏰ 【タイマー】期限切れトークンの自動削除（毎日深夜2時）
// ----------------------------------------------------
app.timer('cleanupExpiredTokens', {
    schedule: '0 0 2 * * *',
    handler: async (myTimer, context) => {
        try {
            const container = await getContainer();
            const now = new Date().toISOString();
            const { resources } = await container.items.query({
                query: "SELECT c.id FROM c WHERE c.docType = 'auth_token' AND c.expiresAt < @now",
                parameters: [{ name: "@now", value: now }]
            }).fetchAll();
            let deleted = 0;
            for (const item of resources) {
                await container.item(item.id, 'auth_token').delete().catch(() => {});
                deleted++;
            }
            context.log(`期限切れトークン削除完了: ${deleted}件`);
        } catch (e) {
            context.log('トークン削除エラー: ' + e.message);
        }
    }
});
