require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');
const { EmailClient } = require('@azure/communication-email');
const { BlobServiceClient, StorageSharedKeyCredential, generateBlobSASQueryParameters, BlobSASPermissions, SASProtocol } = require('@azure/storage-blob');
const crypto = require('crypto');
const { Pool } = require('pg');

// ----------------------------------------------------
// 📁 Blob Storage ユーティリティ
// ----------------------------------------------------
function getBlobServiceClient() {
    return BlobServiceClient.fromConnectionString(process.env.BLOB_CONNECTION_STRING);
}

function getStorageCredential() {
    // 接続文字列からAccountNameとAccountKeyを取得
    const connStr = process.env.BLOB_CONNECTION_STRING || '';
    const nameMatch = connStr.match(/AccountName=([^;]+)/);
    const keyMatch  = connStr.match(/AccountKey=([^;]+)/);
    if (!nameMatch || !keyMatch) return null;
    return {
        accountName: nameMatch[1],
        credential: new StorageSharedKeyCredential(nameMatch[1], keyMatch[1])
    };
}

function generateSasUrl(blobName, permissions, expiryMinutes = 60) {
    const cred = getStorageCredential();
    if (!cred) throw new Error('Blob Storage 認証情報が取得できません');
    const containerName = process.env.BLOB_CONTAINER_NAME || 'survey-files';
    const startsOn = new Date();
    const expiresOn = new Date(Date.now() + expiryMinutes * 60 * 1000);
    const sasParams = generateBlobSASQueryParameters(
        {
            containerName,
            blobName,
            permissions: BlobSASPermissions.parse(permissions),
            startsOn,
            expiresOn,
            protocol: SASProtocol.Https
        },
        cred.credential
    );
    return `https://${cred.accountName}.blob.core.windows.net/${containerName}/${blobName}?${sasParams.toString()}`;
}


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
            await container.item('token_' + token, 'auth_token').delete().catch(() => {});
            return false;
        }
        return true;
    } catch (e) {
        return false;
    }
}

// ----------------------------------------------------
// 📧 メール送信ユーティリティ
// ----------------------------------------------------
async function sendThankYouEmail({ toAddress, subject, bodyText, senderName }) {
    const connectionString = process.env.COMMUNICATION_CONNECTION_STRING;
    const senderAddress = process.env.EMAIL_SENDER_ADDRESS;
    if (!connectionString || !senderAddress) return { success: false, error: '環境変数未設定' };

    const client = new EmailClient(connectionString);
    const message = {
        senderAddress,
        replyTo: [{ address: senderAddress, displayName: senderName || '' }],
        content: {
            subject,
            plainText: bodyText,
        },
        recipients: {
            to: [{ address: toAddress }],
        },
    };
    try {
        const poller = await client.beginSend(message);
        await poller.pollUntilDone();
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
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
                const { id, tenant, title, description, questions, active, thanksMessage, isContest } = body;
                if (!id || !tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'id と tenant は必須です' } };
                const { resource: existing } = await container.item(id, tenant).read();
                const updated = {
                    ...existing,
                    title: title ?? existing.title,
                    description: description ?? existing.description,
                    questions: questions ?? existing.questions,
                    active: active !== undefined ? active : existing.active,
                    thanksMessage: thanksMessage !== undefined ? thanksMessage : (existing.thanksMessage || ''),
                    isContest: isContest !== undefined ? isContest : (existing.isContest || false),
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
// 💬 【回答データ】※送信時にメール自動送信
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
                const { surveyId, tenant, answers, responseId } = body;
                if (!surveyId || !tenant || !answers) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'surveyId, tenant, answers は必須です' } };

                // ── メールアドレス 1日1回チェック（送信スキップ方式）──────
                const emailAnswer = Object.values(answers).find(v =>
                    typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())
                );
                let emailAlreadySentToday = false;
                if (emailAnswer) {
                    const todayJst = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
                    const tomorrowJst = new Date(new Date(todayJst).getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
                    const { resources: dupCheck } = await container.items.query({
                        query: "SELECT TOP 1 c.id FROM c WHERE c.tenant = @tenant AND c.surveyId = @surveyId AND c.docType = 'survey_response' AND c.emailAddress = @email AND c.createdAt >= @today AND c.createdAt < @tomorrow",
                        parameters: [
                            { name: "@tenant",   value: tenant },
                            { name: "@surveyId", value: surveyId },
                            { name: "@email",    value: emailAnswer.trim().toLowerCase() },
                            { name: "@today",    value: todayJst + 'T00:00:00.000Z' },
                            { name: "@tomorrow", value: tomorrowJst + 'T00:00:00.000Z' }
                        ]
                    }).fetchAll();
                    if (dupCheck.length > 0) {
                        emailAlreadySentToday = true; // 回答は保存するがメールはスキップ
                        context.log(`[重複メールスキップ] tenant=${tenant} surveyId=${surveyId} email=${emailAnswer.trim()}`);
                        // スキップもメールログに記録
                        await container.items.create({
                            id: crypto.randomUUID(),
                            docType: 'email_log',
                            tenant,
                            surveyId,
                            toAddress: emailAnswer.trim(),
                            subject: '（重複のためスキップ）',
                            senderName: '',
                            success: false,
                            skipped: true,
                            error: '同一メールアドレスへの本日2回目以降の送信のためスキップしました',
                            createdAt: new Date().toISOString()
                        }).catch(() => {});
                    }
                }
                // ────────────────────────────────────────────────────────

                // 回答を保存（2回目以降も保存する）
                await container.items.create({
                    id: responseId || crypto.randomUUID(),
                    docType: 'survey_response',
                    surveyId, tenant, answers,
                    emailAddress: emailAnswer ? emailAnswer.trim().toLowerCase() : null,
                    createdAt: new Date().toISOString()
                });

                // メール送信（本日初回のみ）
                if (emailAnswer && !emailAlreadySentToday) {
                    try {
                        // アンケート個別設定 → テナント共通設定の順で取得
                        let emailSettings = null;
                        const surveySettingId = 'emailsettings_' + surveyId;
                        const tenantSettingId = 'emailsettings_tenant_' + tenant;
                        try {
                            const { resource } = await container.item(surveySettingId, tenant).read();
                            if (resource && resource.emailEnabled) emailSettings = resource;
                        } catch (e) {}
                        if (!emailSettings) {
                            try {
                                const { resource } = await container.item(tenantSettingId, tenant).read();
                                if (resource && resource.emailEnabled) emailSettings = resource;
                            } catch (e) {}
                        }
                        if (emailSettings) {
                            const emailResult = await sendThankYouEmail({
                                toAddress: emailAnswer.trim(),
                                subject: emailSettings.subject || 'アンケートへのご回答ありがとうございました',
                                bodyText: emailSettings.bodyText || '',
                                senderName: emailSettings.senderName || '',
                            });
                            await container.items.create({
                                id: crypto.randomUUID(),
                                docType: 'email_log',
                                tenant,
                                surveyId,
                                toAddress: emailAnswer.trim(),
                                subject: emailSettings.subject || 'アンケートへのご回答ありがとうございました',
                                senderName: emailSettings.senderName || '',
                                success: emailResult.success,
                                error: emailResult.error || null,
                                createdAt: new Date().toISOString()
                            }).catch(() => {});
                            context.log(`[メール送信] tenant=${tenant} to=${emailAnswer.trim()} success=${emailResult.success}${emailResult.error ? ' error=' + emailResult.error : ''}`);
                        }
                    } catch (e) {
                        context.log(`[メール送信エラー] tenant=${tenant} error=${e.message}`);
                    }
                }

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
                if (surveyId) {
                    try {
                        const { resource } = await container.item('design_' + surveyId, tenant).read();
                        if (resource) return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { ...resource, _source: 'survey' } };
                    } catch (e) {}
                }
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
                const { tenant, resultKey, resultTitle, diagTitle, diagId: logDiagId } = body;
                if (!tenant) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant は必須です' } };
                await container.items.create({
                    id: crypto.randomUUID(),
                    docType: 'diagnosis_log',
                    tenant, resultKey, resultTitle,
                    diagTitle: diagTitle || '',
                    diagId: logDiagId || '',
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
// 📨 【メール送信ログ】取得
// ----------------------------------------------------
app.http('emaillog', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return secureJson({ error: '認証が必要です' }, 401);

            const url = new URL(request.url);
            const tenant = url.searchParams.get('tenant');
            const surveyId = url.searchParams.get('surveyId');
            if (!tenant) return secureJson({ error: 'tenant は必須です' }, 400);

            const container = await getContainer();
            let query, parameters;
            if (surveyId) {
                query = "SELECT TOP 200 * FROM c WHERE c.tenant = @tenant AND c.surveyId = @surveyId AND c.docType = 'email_log' ORDER BY c.createdAt DESC";
                parameters = [{ name: "@tenant", value: tenant }, { name: "@surveyId", value: surveyId }];
            } else {
                query = "SELECT TOP 200 * FROM c WHERE c.tenant = @tenant AND c.docType = 'email_log' ORDER BY c.createdAt DESC";
                parameters = [{ name: "@tenant", value: tenant }];
            }
            const { resources } = await container.items.query({ query, parameters }).fetchAll();
            return secureJson(resources);
        } catch (e) {
            return secureJson({ error: e.message }, 500);
        }
    }
});

// ----------------------------------------------------
// 📧 【メール設定】テナント×アンケート種別ごと
// ----------------------------------------------------
app.http('emailsettings', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const container = await getContainer();

            if (request.method === 'GET') {
                const tenant = url.searchParams.get('tenant');
                const surveyId = url.searchParams.get('surveyId');
                if (!tenant) return secureJson({ error: 'tenant は必須です' }, 400);

                const id = surveyId ? 'emailsettings_' + surveyId : 'emailsettings_tenant_' + tenant;
                try {
                    const { resource } = await container.item(id, tenant).read();
                    return secureJson(resource || { emailEnabled: false });
                } catch (e) {
                    return secureJson({ emailEnabled: false });
                }
            }

            if (request.method === 'POST') {
                const token = request.headers.get('x-admin-token');
                if (!await verifyToken(token)) return secureJson({ error: '認証が必要です' }, 401);

                const body = await request.json().catch(() => ({}));
                const { tenant, surveyId, emailEnabled, subject, bodyText, senderName } = body;
                if (!tenant) return secureJson({ error: 'tenant は必須です' }, 400);

                const id = surveyId ? 'emailsettings_' + surveyId : 'emailsettings_tenant_' + tenant;
                const existing = await container.item(id, tenant).read()
                    .then(r => r.resource || {}).catch(() => ({}));

                const updated = {
                    ...existing,
                    id,
                    docType: 'email_settings',
                    tenant,
                    surveyId: surveyId || null,
                    emailEnabled: emailEnabled !== undefined ? emailEnabled : (existing.emailEnabled || false),
                    subject: subject !== undefined ? subject : (existing.subject || ''),
                    bodyText: bodyText !== undefined ? bodyText : (existing.bodyText || ''),
                    senderName: senderName !== undefined ? senderName : (existing.senderName || ''),
                    updatedAt: new Date().toISOString()
                };
                await container.items.upsert(updated);
                return secureJson(updated);
            }
        } catch (e) {
            return secureJson({ error: e.message }, 500);
        }
    }
});

// ----------------------------------------------------
// 📅 【定期レポート設定】GET / POST
// ----------------------------------------------------
app.http('reportsettings', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const url = new URL(request.url);
            const container = await getContainer();

            if (request.method === 'GET') {
                const tenant = url.searchParams.get('tenant');
                if (!tenant) return secureJson({ error: 'tenant は必須です' }, 400);
                const token = request.headers.get('x-admin-token');
                if (!await verifyToken(token)) return secureJson({ error: '認証が必要です' }, 401);
                const id = 'reportsettings_' + tenant;
                try {
                    const { resource } = await container.item(id, tenant).read();
                    return secureJson(resource || { enabled: false, recipients: [], surveyIds: [], dayOfWeek: '1', hour: '9' });
                } catch (e) {
                    return secureJson({ enabled: false, recipients: [], surveyIds: [], dayOfWeek: '1', hour: '9' });
                }
            }

            if (request.method === 'POST') {
                const token = request.headers.get('x-admin-token');
                if (!await verifyToken(token)) return secureJson({ error: '認証が必要です' }, 401);
                const body = await request.json().catch(() => ({}));
                const { tenant, enabled, recipients, surveyIds, dayOfWeek, hour } = body;
                if (!tenant) return secureJson({ error: 'tenant は必須です' }, 400);
                const id = 'reportsettings_' + tenant;
                const existing = await container.item(id, tenant).read()
                    .then(r => r.resource || {}).catch(() => ({}));
                const updated = {
                    ...existing, id,
                    docType: 'report_settings',
                    tenant,
                    enabled: enabled !== undefined ? enabled : (existing.enabled || false),
                    recipients: recipients !== undefined ? recipients : (existing.recipients || []),
                    surveyIds: surveyIds !== undefined ? surveyIds : (existing.surveyIds || []),
                    dayOfWeek: dayOfWeek !== undefined ? dayOfWeek : (existing.dayOfWeek || '1'),
                    hour: hour !== undefined ? hour : (existing.hour || '9'),
                    rangeMode: body.rangeMode !== undefined ? body.rangeMode : (existing.rangeMode || 'all'),
                    rangeDays: body.rangeDays !== undefined ? parseInt(body.rangeDays) : (existing.rangeDays || 7),
                    updatedAt: new Date().toISOString()
                };
                await container.items.upsert(updated);
                return secureJson(updated);
            }
        } catch (e) {
            return secureJson({ error: e.message }, 500);
        }
    }
});

// ----------------------------------------------------
// 📊 【グループ全体統計】全テナント回答数サマリー
// ----------------------------------------------------
app.http('groupstats', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return secureJson({ error: '認証が必要です' }, 401);
            const url = new URL(request.url);
            const days = parseInt(url.searchParams.get('days') || '30');
            const container = await getContainer();

            const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
            const tenants = ['herbelle', 'diana', 'dstylehd'];
            const result = {};

            for (const tenant of tenants) {
                // アンケート定義取得
                const { resources: surveys } = await container.items.query({
                    query: "SELECT c.id, c.title, c.active FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_definition' ORDER BY c.createdAt DESC",
                    parameters: [{ name: "@tenant", value: tenant }]
                }).fetchAll();

                // 回答数取得
                const { resources: responses } = await container.items.query({
                    query: "SELECT c.surveyId FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_response' AND c.createdAt >= @since",
                    parameters: [{ name: "@tenant", value: tenant }, { name: "@since", value: since }]
                }).fetchAll();

                const countMap = {};
                responses.forEach(r => { countMap[r.surveyId] = (countMap[r.surveyId] || 0) + 1; });

                result[tenant] = {
                    surveys: surveys.map(s => ({
                        id: s.id, title: s.title, active: s.active,
                        count: countMap[s.id] || 0
                    })),
                    total: responses.length
                };
            }
            return secureJson(result);
        } catch (e) {
            return secureJson({ error: e.message }, 500);
        }
    }
});

// ----------------------------------------------------
// ⏰ 【タイマー】定期CSVレポート送信（毎時0分起動）
// ----------------------------------------------------
app.timer('sendScheduledReports', {
    schedule: '0 0 * * * *',  // 毎時0分に起動し、対象テナントを確認して送信
    handler: async (myTimer, context) => {
        try {
            const container = await getContainer();
            // JST時刻を取得
            const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
            const currentHour = nowJst.getUTCHours().toString();
            const currentDow  = nowJst.getUTCDay().toString(); // 0=日,1=月...6=土

            // 全テナントのレポート設定を取得
            const { resources: allSettings } = await container.items.query({
                query: "SELECT * FROM c WHERE c.docType = 'report_settings' AND c.enabled = true"
            }).fetchAll();

            for (const setting of allSettings) {
                // 曜日・時刻チェック（'7'=毎日）
                const dowMatch = setting.dayOfWeek === '7' || setting.dayOfWeek === currentDow;
                const hourMatch = setting.hour === currentHour;
                if (!dowMatch || !hourMatch) continue;
                if (!setting.recipients || setting.recipients.length === 0) continue;

                const tenant = setting.tenant;
                context.log(`[定期レポート] 送信開始 tenant=${tenant}`);

                try {
                    // ── 診断ログレポート（herbelle_diagテナント専用）──────────
                    if (tenant === 'herbelle_diag') {
                        // 送信範囲に応じてクエリを切り替え
                        const diagRangeMode = setting.rangeMode || 'all';
                        const diagRangeDays = parseInt(setting.rangeDays) || 7;
                        let diagQuery, diagParams;
                        if (diagRangeMode === 'days') {
                            const diagSince = new Date(Date.now() - diagRangeDays * 24 * 60 * 60 * 1000).toISOString();
                            diagQuery = "SELECT * FROM c WHERE c.tenant = 'herbelle' AND c.docType = 'diagnosis_log' AND c.createdAt >= @since ORDER BY c.createdAt DESC";
                            diagParams = [{ name: "@since", value: diagSince }];
                        } else {
                            diagQuery = "SELECT * FROM c WHERE c.tenant = 'herbelle' AND c.docType = 'diagnosis_log' ORDER BY c.createdAt DESC";
                            diagParams = [];
                        }
                        const { resources: diagLogs } = await container.items.query({
                            query: diagQuery, parameters: diagParams
                        }).fetchAll();

                        if (diagLogs.length === 0) {
                            context.log(`[定期レポート] 診断ログなし スキップ`);
                            continue;
                        }

                        const header = ['受診日時', '診断名', '結果タイプ'].join(',');
                        const rows = diagLogs.map(l => {
                            const date = new Date(l.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                            return ['"' + date + '"',
                                '"' + (l.diagTitle || '—').replace(/"/g, '""') + '"',
                                '"' + (l.resultTitle || '—').replace(/"/g, '""') + '"'].join(',');
                        });
                        const csvContent = '\uFEFF' + header + '\n' + rows.join('\n');
                        const csvBase64 = Buffer.from(csvContent, 'utf-8').toString('base64');
                        const dateStr = nowJst.toISOString().slice(0, 10);
                        const diagRangeLabel = (setting.rangeMode === 'days') ? `直近${setting.rangeDays || 7}日分` : '全件';
                        const subject = `[Herbelle] 診断ログレポート ${dateStr}（${diagRangeLabel}・${diagLogs.length}件）`;

                        const connectionString = process.env.COMMUNICATION_CONNECTION_STRING;
                        const senderAddress = process.env.EMAIL_SENDER_ADDRESS;
                        if (!connectionString || !senderAddress) continue;
                        const { EmailClient: EC } = require('@azure/communication-email');
                        const emailClient2 = new EC(connectionString);

                        for (const recipient of setting.recipients) {
                            if (!recipient || !recipient.trim()) continue;
                            try {
                                const poller = await emailClient2.beginSend({
                                    senderAddress,
                                    content: { subject, plainText: `Herbelle の診断ログレポートをお送りします。\n\n総件数：${diagLogs.length}件\n\n添付のCSVファイルをご確認ください。` },
                                    recipients: { to: [{ address: recipient.trim() }] },
                                    attachments: [{ name: `herbelle_diagnosis_log_${dateStr}.csv`, contentType: 'text/csv', contentInBase64: csvBase64 }]
                                });
                                await poller.pollUntilDone();
                                context.log(`[診断レポート] 送信成功 to=${recipient.trim()}`);
                                await container.items.create({
                                    id: crypto.randomUUID(), docType: 'email_log', tenant: 'herbelle',
                                    surveyId: 'diag_report', toAddress: recipient.trim(), subject,
                                    senderName: 'システム定期レポート', success: true, skipped: false, error: null,
                                    createdAt: new Date().toISOString()
                                }).catch(() => {});
                            } catch (e) {
                                context.log(`[診断レポート] 送信失敗 to=${recipient} error=${e.message}`);
                            }
                        }
                        continue; // 通常のアンケートCSV処理はスキップ
                    }
                    // ────────────────────────────────────────────────────────

                    // 対象アンケートの回答を取得してCSV生成
                    let surveyIds = setting.surveyIds || [];

                    // surveyIds が空 or ['all'] なら全アンケートを対象に
                    if (surveyIds.length === 0 || surveyIds[0] === 'all') {
                        const { resources: surveys } = await container.items.query({
                            query: "SELECT c.id FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_definition'",
                            parameters: [{ name: "@tenant", value: tenant }]
                        }).fetchAll();
                        surveyIds = surveys.map(s => s.id);
                    }

                    // 全アンケートの定義と回答を取得
                    const csvSections = [];
                    let totalCount = 0;
                    for (const surveyId of surveyIds) {
                        let surveyTitle = surveyId;
                        try {
                            const { resource: surveyDef } = await container.item(surveyId, tenant).read();
                            if (surveyDef) surveyTitle = surveyDef.title || surveyId;
                        } catch (e) {}

                        // 送信範囲に応じてクエリを切り替え
                        const rangeMode = setting.rangeMode || 'all';
                        const rangeDays = parseInt(setting.rangeDays) || 7;
                        let responseQuery, responseParams;
                        if (rangeMode === 'days') {
                            const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
                            responseQuery = "SELECT * FROM c WHERE c.tenant = @tenant AND c.surveyId = @sid AND c.docType = 'survey_response' AND c.createdAt >= @since ORDER BY c.createdAt DESC";
                            responseParams = [{ name: "@tenant", value: tenant }, { name: "@sid", value: surveyId }, { name: "@since", value: since }];
                        } else {
                            responseQuery = "SELECT * FROM c WHERE c.tenant = @tenant AND c.surveyId = @sid AND c.docType = 'survey_response' ORDER BY c.createdAt DESC";
                            responseParams = [{ name: "@tenant", value: tenant }, { name: "@sid", value: surveyId }];
                        }
                        const { resources: responses } = await container.items.query({
                            query: responseQuery, parameters: responseParams
                        }).fetchAll();

                        if (responses.length === 0) continue;
                        totalCount += responses.length;

                        // CSV変換（質問ラベルをヘッダーに使用）
                        const allKeys = new Set();
                        responses.forEach(r => Object.keys(r.answers || {}).forEach(k => allKeys.add(k)));
                        const keys = Array.from(allKeys);

                        // アンケート定義から質問IDとラベルのマップを作成
                        let labelMap = {};
                        try {
                            const { resource: surveyDef } = await container.item(surveyId, tenant).read();
                            if (surveyDef && surveyDef.questions) {
                                surveyDef.questions.forEach(q => { labelMap[q.id] = q.label || q.id; });
                            }
                        } catch (e) {}

                        // ヘッダーは質問ラベル（定義にないIDは「削除済み質問N」として表示）
                        let unknownCount = 0;
                        const headerLabels = keys.map(k => {
                            if (labelMap[k]) return '"' + labelMap[k].replace(/"/g, '""') + '"';
                            unknownCount++;
                            return '"削除済み質問' + unknownCount + '"';
                        });
                        const header = ['回答日時', ...headerLabels].join(',');
                        const rows = responses.map(r => {
                            const date = new Date(r.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
                            const vals = keys.map(k => {
                                const v = (r.answers || {})[k] || '';
                                return '"' + String(v).replace(/"/g, '""') + '"';
                            });
                            return ['"' + date + '"', ...vals].join(',');
                        });
                        csvSections.push(`【${surveyTitle}】\n${header}\n${rows.join('\n')}`);
                    }

                    if (csvSections.length === 0) {
                        context.log(`[定期レポート] 回答なし tenant=${tenant} スキップ`);
                        continue;
                    }

                    const csvContent = '\uFEFF' + csvSections.join('\n\n'); // BOM付きUTF-8
                    const csvBase64 = Buffer.from(csvContent, 'utf-8').toString('base64');

                    const dateStr = nowJst.toISOString().slice(0, 10);
                    const tenantLabel = { herbelle: 'Herbelle', diana: 'Diana', dstylehd: 'DstyleHD' }[tenant] || tenant;
                    const rangeLabel = (setting.rangeMode === 'days') ? `直近${setting.rangeDays || 7}日分` : '全件';
                    const subject = `[${tenantLabel}] アンケート回答レポート ${dateStr}（${rangeLabel}・${totalCount}件）`;

                    // 送信先ごとにメール送信
                    const connectionString = process.env.COMMUNICATION_CONNECTION_STRING;
                    const senderAddress = process.env.EMAIL_SENDER_ADDRESS;
                    if (!connectionString || !senderAddress) {
                        context.log('[定期レポート] 環境変数未設定 スキップ');
                        continue;
                    }
                    const { EmailClient } = require('@azure/communication-email');
                    const emailClient = new EmailClient(connectionString);

                    for (const recipient of setting.recipients) {
                        if (!recipient || !recipient.trim()) continue;
                        try {
                            const message = {
                                senderAddress,
                                content: {
                                    subject,
                                    plainText: `${tenantLabel} のアンケート回答レポートをお送りします。\n\n対象期間：${dateStr} 時点の全回答\n総回答数：${totalCount}件\n\n添付のCSVファイルをご確認ください。`,
                                },
                                recipients: { to: [{ address: recipient.trim() }] },
                                attachments: [{
                                    name: `${tenantLabel}_report_${dateStr}.csv`,
                                    contentType: 'text/csv',
                                    contentInBase64: csvBase64
                                }]
                            };
                            const poller = await emailClient.beginSend(message);
                            await poller.pollUntilDone();
                            context.log(`[定期レポート] 送信成功 tenant=${tenant} to=${recipient.trim()}`);
                            // 送信ログ記録
                            await container.items.create({
                                id: crypto.randomUUID(),
                                docType: 'email_log',
                                tenant,
                                surveyId: 'report',
                                toAddress: recipient.trim(),
                                subject,
                                senderName: 'システム定期レポート',
                                success: true,
                                skipped: false,
                                error: null,
                                createdAt: new Date().toISOString()
                            }).catch(() => {});
                        } catch (e) {
                            context.log(`[定期レポート] 送信失敗 to=${recipient} error=${e.message}`);
                            await container.items.create({
                                id: crypto.randomUUID(),
                                docType: 'email_log',
                                tenant,
                                surveyId: 'report',
                                toAddress: recipient.trim(),
                                subject,
                                senderName: 'システム定期レポート',
                                success: false,
                                skipped: false,
                                error: e.message,
                                createdAt: new Date().toISOString()
                            }).catch(() => {});
                        }
                    }
                } catch (e) {
                    context.log(`[定期レポート] エラー tenant=${tenant} error=${e.message}`);
                }
            }
        } catch (e) {
            context.log('[定期レポート タイマーエラー] ' + e.message);
        }
    }
});

// ----------------------------------------------------
// 📧 【一斉メール送信】POST /api/bulkmail
// ----------------------------------------------------
app.http('bulkmail', {
    methods: ['GET', 'POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return secureJson({ error: '認証が必要です' }, 401);

            const url = new URL(request.url);
            const container = await getContainer();

            // GET: 予約メール一覧取得
            if (request.method === 'GET') {
                const tenant = url.searchParams.get('tenant');
                if (!tenant) return secureJson({ error: 'tenant は必須です' }, 400);
                const { resources } = await container.items.query({
                    query: "SELECT * FROM c WHERE c.docType = 'scheduled_mail' AND c.tenant = @tenant ORDER BY c.scheduledAt ASC",
                    parameters: [{ name: "@tenant", value: tenant }]
                }).fetchAll();
                return secureJson(resources);
            }

            // POST: 送信 or 予約保存
            const body = await request.json().catch(() => ({}));
            const { tenant, surveyId, toAddresses, subject, bodyText, scheduleMode, scheduledAt } = body;
            if (!tenant || !toAddresses?.length || !subject || !bodyText) {
                return secureJson({ error: 'tenant, toAddresses, subject, bodyText は必須です' }, 400);
            }

            // 予約送信の場合はCosmosDBに保存
            if (scheduleMode === 'scheduled' && scheduledAt) {
                await container.items.create({
                    id: crypto.randomUUID(),
                    docType: 'scheduled_mail',
                    tenant, surveyId: surveyId || '',
                    toAddresses, subject, bodyText,
                    scheduledAt,
                    status: 'pending',
                    createdAt: new Date().toISOString()
                });
                return secureJson({ status: 'scheduled', count: toAddresses.length });
            }

            // 即時送信
            const connectionString = process.env.COMMUNICATION_CONNECTION_STRING;
            const senderAddress = process.env.EMAIL_SENDER_ADDRESS;
            if (!connectionString || !senderAddress) {
                return secureJson({ error: 'メール設定が未構成です' }, 500);
            }
            const { EmailClient } = require('@azure/communication-email');
            const emailClient = new EmailClient(connectionString);
            let successCount = 0, failCount = 0;
            for (const toAddress of toAddresses) {
                if (!toAddress?.trim()) continue;
                try {
                    const poller = await emailClient.beginSend({
                        senderAddress,
                        content: { subject, plainText: bodyText },
                        recipients: { to: [{ address: toAddress.trim() }] }
                    });
                    await poller.pollUntilDone();
                    successCount++;
                    // ログ記録
                    await container.items.create({
                        id: crypto.randomUUID(), docType: 'email_log', tenant,
                        surveyId: surveyId || 'bulk', toAddress: toAddress.trim(),
                        subject, senderName: '一斉メール送信', success: true,
                        skipped: false, error: null, createdAt: new Date().toISOString()
                    }).catch(() => {});
                } catch (e) {
                    failCount++;
                    await container.items.create({
                        id: crypto.randomUUID(), docType: 'email_log', tenant,
                        surveyId: surveyId || 'bulk', toAddress: toAddress.trim(),
                        subject, senderName: '一斉メール送信', success: false,
                        skipped: false, error: e.message, createdAt: new Date().toISOString()
                    }).catch(() => {});
                    context.log(`[一斉送信失敗] to=${toAddress} error=${e.message}`);
                }
            }
            return secureJson({ status: 'ok', successCount, failCount });
        } catch (e) {
            return secureJson({ error: e.message }, 500);
        }
    }
});

// ----------------------------------------------------
// 📧 【予約メール削除】DELETE /api/bulkmail
// ----------------------------------------------------
app.http('bulkmailDelete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    route: 'bulkmail/{id}',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return secureJson({ error: '認証が必要です' }, 401);
            const id = request.params.id;
            const container = await getContainer();
            // パーティションキーを特定するためにまず取得
            const { resources } = await container.items.query({
                query: "SELECT * FROM c WHERE c.id = @id AND c.docType = 'scheduled_mail'",
                parameters: [{ name: "@id", value: id }]
            }).fetchAll();
            if (resources.length === 0) return secureJson({ error: '見つかりません' }, 404);
            await container.item(id, resources[0].tenant).delete();
            return secureJson({ status: 'deleted' });
        } catch (e) {
            return secureJson({ error: e.message }, 500);
        }
    }
});

// ----------------------------------------------------
// ⏰ 【タイマー】予約メール送信（毎分チェック）
// ----------------------------------------------------
app.timer('sendScheduledMails', {
    schedule: '0 * * * * *',  // 毎分起動
    handler: async (myTimer, context) => {
        try {
            const container = await getContainer();
            const nowIso = new Date().toISOString();
            // 送信時刻を過ぎた pending の予約を取得
            const { resources: pendingMails } = await container.items.query({
                query: "SELECT * FROM c WHERE c.docType = 'scheduled_mail' AND c.status = 'pending' AND c.scheduledAt <= @now",
                parameters: [{ name: "@now", value: nowIso }]
            }).fetchAll();

            if (pendingMails.length === 0) return;

            const connectionString = process.env.COMMUNICATION_CONNECTION_STRING;
            const senderAddress = process.env.EMAIL_SENDER_ADDRESS;
            if (!connectionString || !senderAddress) return;
            const { EmailClient } = require('@azure/communication-email');
            const emailClient = new EmailClient(connectionString);

            for (const mail of pendingMails) {
                // statusをprocessingに更新（二重送信防止）
                await container.items.upsert({ ...mail, status: 'processing' });
                let successCount = 0, failCount = 0;
                for (const toAddress of (mail.toAddresses || [])) {
                    if (!toAddress?.trim()) continue;
                    try {
                        const poller = await emailClient.beginSend({
                            senderAddress,
                            content: { subject: mail.subject, plainText: mail.bodyText },
                            recipients: { to: [{ address: toAddress.trim() }] }
                        });
                        await poller.pollUntilDone();
                        successCount++;
                        await container.items.create({
                            id: crypto.randomUUID(), docType: 'email_log', tenant: mail.tenant,
                            surveyId: mail.surveyId || 'bulk', toAddress: toAddress.trim(),
                            subject: mail.subject, senderName: '予約メール送信', success: true,
                            skipped: false, error: null, createdAt: new Date().toISOString()
                        }).catch(() => {});
                    } catch (e) {
                        failCount++;
                        context.log(`[予約送信失敗] to=${toAddress} error=${e.message}`);
                    }
                }
                // statusをdoneに更新
                await container.items.upsert({ ...mail, status: 'done', sentAt: new Date().toISOString(), successCount, failCount });
                context.log(`[予約送信完了] id=${mail.id} success=${successCount} fail=${failCount}`);
            }
        } catch (e) {
            context.log('[予約送信タイマーエラー] ' + e.message);
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
// ----------------------------------------------------
// 🔐 【Entra ID認証】MSALトークンでAPIトークン発行
// ----------------------------------------------------
app.http('msalauth', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const reqBody = await request.json();
            const { idToken, tenant, accessToken } = reqBody;
            if (!idToken || !tenant) {
                return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'idToken と tenant は必須です' } };
            }
            const parts = idToken.split('.');
            if (parts.length !== 3) {
                return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '無効なトークン形式' } };
            }
            const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
            const TENANT_ID = '2648ac1f-8786-40fb-80f8-14bd84511449';
            const CLIENT_ID = '1f4f2ade-4eeb-4f65-8fbd-394378a63518';
            const validIssuer = payload.iss && (
                payload.iss === `https://login.microsoftonline.com/${TENANT_ID}/v2.0` ||
                payload.iss === `https://sts.windows.net/${TENANT_ID}/`
            );
            const validAudience = payload.aud === CLIENT_ID;
            const notExpired = payload.exp && payload.exp * 1000 > Date.now();
            if (!validIssuer || !validAudience || !notExpired) {
                // 不正アクセスをログに記録
                try {
                    const container = await getContainer();
                    await container.items.create({
                        id: crypto.randomUUID(),
                        docType: 'access_log',
                        tenant,
                        result: 'failure',
                        ip: request.headers.get('x-forwarded-for') || 'unknown',
                        userName: 'unknown（トークン検証失敗）',
                        userEmail: 'unknown',
                        createdAt: new Date().toISOString()
                    }).catch(() => {});
                } catch(e) {}
                return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'トークンの検証に失敗しました' } };
            }
            // ===== Graph APIでグループ取得してアクセス制御 =====
            const GROUP_DELIGHT    = '6e4af16e-cfe1-49a6-968e-05b8cef847d8'; // ディライトテクノロジーズ事業部
            const GROUP_DIANA      = '560396ae-5774-4b3e-b451-9602d140f921'; // 株式会社ダイアナ
            const GROUP_ZENSYA     = '84b52c84-a162-43e0-a4be-30bc13ff36b0'; // 全社連絡用
            const GROUP_DSTYLE_LAB = '22b1fe31-87e4-4dc2-9387-d98688477ac1'; // Dstyle総合研究所

            const ALLOWED_GROUPS = {
                portal:    [GROUP_DELIGHT],
                herbelle:  [GROUP_DELIGHT, GROUP_DSTYLE_LAB],
                diana:     [GROUP_DELIGHT, GROUP_DIANA],
                dstylehd:  [GROUP_DELIGHT, GROUP_ZENSYA],
            };

            // フロントから送られたaccessTokenでGraph APIを呼びグループ取得
            let userGroups = [];
            if (accessToken) {
                try {
                    const graphRes = await fetch('https://graph.microsoft.com/v1.0/me/memberOf?$select=id', {
                        headers: { 'Authorization': 'Bearer ' + accessToken }
                    });
                    if (graphRes.ok) {
                        const graphData = await graphRes.json();
                        userGroups = (graphData.value || []).map(g => g.id);
                    }
                } catch(e) { context.log('Graph API error:', e.message); }
            }

            const allowedForTenant = ALLOWED_GROUPS[tenant] || [GROUP_DELIGHT];
            const hasAccess = allowedForTenant.some(g => userGroups.includes(g));

            if (!hasAccess) {
                // アクセス拒否をログに記録
                const container2 = await getContainer();
                const userName2 = payload.name || payload.preferred_username || 'unknown';
                await container2.items.create({
                    id: crypto.randomUUID(),
                    docType: 'access_log',
                    tenant,
                    result: 'forbidden',
                    ip: request.headers.get('x-forwarded-for') || 'unknown',
                    userName: userName2,
                    userEmail: payload.preferred_username || 'unknown',
                    createdAt: new Date().toISOString()
                }).catch(() => {});
                return { status: 403, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'このダッシュボードへのアクセス権限がありません' } };
            }

            const token = await issueToken('auth_token');
            const container = await getContainer();
            const userName = payload.name || payload.preferred_username || payload.upn || 'unknown';
            const userEmail = payload.preferred_username || payload.upn || payload.email || 'unknown';
            await container.items.create({
                id: crypto.randomUUID(),
                docType: 'access_log',
                tenant,
                result: 'success',
                ip: request.headers.get('x-forwarded-for') || 'unknown',
                userName,
                userEmail,
                createdAt: new Date().toISOString()
            }).catch(() => {});
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { token } };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});
// ----------------------------------------------------
// 📁 【ファイルアップロード】回答者向け SAS URL 発行
// POST /api/fileupload
// Body: { tenant, surveyId, responseId, fileName, contentType }
// Returns: { uploadUrl, blobName }
// ----------------------------------------------------
app.http('fileupload', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const body = await request.json().catch(() => ({}));
            const { tenant, surveyId, responseId, fileName, contentType } = body;
            if (!tenant || !surveyId || !responseId || !fileName) {
                return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant, surveyId, responseId, fileName は必須です' } };
            }
            // ファイル名をサニタイズ
            const safeName = fileName.replace(/[^a-zA-Z0-9.\-_\u3040-\u9FFF\uFF00-\uFFEF]/g, '_');
            const blobName = `${tenant}/${surveyId}/${responseId}/${Date.now()}_${safeName}`;
            const uploadUrl = generateSasUrl(blobName, 'cw', 30); // create + write, 30分
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { uploadUrl, blobName } };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 📁 【スタッフアップロード】管理者向け SAS URL 発行
// POST /api/staffupload
// Body: { tenant, surveyId, responseId, fileName }
// Returns: { uploadUrl, blobName }
// ----------------------------------------------------
app.http('staffupload', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
            const body = await request.json().catch(() => ({}));
            const { tenant, surveyId, responseId, fileName } = body;
            if (!tenant || !surveyId || !responseId || !fileName) {
                return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant, surveyId, responseId, fileName は必須です' } };
            }
            const safeName = fileName.replace(/[^a-zA-Z0-9.\-_\u3040-\u9FFF\uFF00-\uFFEF]/g, '_');
            const blobName = `${tenant}/${surveyId}/${responseId}/staff_${Date.now()}_${safeName}`;
            const uploadUrl = generateSasUrl(blobName, 'cw', 30);
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { uploadUrl, blobName } };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 📁 【ファイルダウンロード】SAS URL 発行
// GET /api/filedownload?blobName=xxx&tenant=xxx
// Returns: { downloadUrl }
// ----------------------------------------------------
app.http('filedownload', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
            const url = new URL(request.url);
            const blobName = url.searchParams.get('blobName');
            if (!blobName) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'blobName は必須です' } };
            const downloadUrl = generateSasUrl(blobName, 'r', 60); // read, 60分
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { downloadUrl } };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 📁 【ファイル一覧】回答IDに紐づくファイル一覧
// GET /api/filelist?tenant=xxx&surveyId=xxx&responseId=xxx
// Returns: [{ blobName, fileName, size, lastModified }]
// ----------------------------------------------------
app.http('filelist', {
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
            const url = new URL(request.url);
            const tenant = url.searchParams.get('tenant');
            const surveyId = url.searchParams.get('surveyId');
            const responseId = url.searchParams.get('responseId');
            if (!tenant || !surveyId || !responseId) {
                return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'tenant, surveyId, responseId は必須です' } };
            }
            const prefix = `${tenant}/${surveyId}/${responseId}/`;
            const blobServiceClient = getBlobServiceClient();
            const containerClient = blobServiceClient.getContainerClient(process.env.BLOB_CONTAINER_NAME || 'survey-files');
            const files = [];
            for await (const blob of containerClient.listBlobsFlat({ prefix })) {
                const fileName = blob.name.split('/').pop().replace(/^\d+_/, '').replace(/^staff_\d+_/, '');
                files.push({
                    blobName: blob.name,
                    fileName,
                    size: blob.properties.contentLength,
                    lastModified: blob.properties.lastModified,
                    isStaffUpload: blob.name.includes('/staff_')
                });
            }
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: files };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 📁 【ファイル削除】管理者向け
// DELETE /api/filedelete?blobName=xxx
// ----------------------------------------------------
app.http('filedelete', {
    methods: ['DELETE'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
            const url = new URL(request.url);
            const blobName = url.searchParams.get('blobName');
            if (!blobName) return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'blobName は必須です' } };
            const blobServiceClient = getBlobServiceClient();
            const containerClient = blobServiceClient.getContainerClient(process.env.BLOB_CONTAINER_NAME || 'survey-files');
            await containerClient.deleteBlob(blobName);
            return { status: 200, headers: { 'Content-Type': 'application/json' }, jsonBody: { status: 'deleted' } };
        } catch (e) {
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});

// ----------------------------------------------------
// 🐘 PostgreSQL 接続プール
// ----------------------------------------------------
let pgPool = null;
function getPgPool() {
    if (!pgPool) {
        pgPool = new Pool({
            host:     process.env.PG_HOST,
            port:     parseInt(process.env.PG_PORT || '5432'),
            database: process.env.PG_DB,
            user:     process.env.PG_USER,
            password: process.env.PG_PASS,
            ssl:      process.env.PG_SSLMODE === 'require' ? { rejectUnauthorized: false } : false,
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 30000, // 30秒に延長
        });
    }
    return pgPool;
}

// ----------------------------------------------------
// 👗 【Diana採寸データ取得】PostgreSQL連携
// POST /api/diana-member
// body: { sldsslcd, dia_cd, b_day }
// ----------------------------------------------------
app.http('diana-member', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        try {
            const token = request.headers.get('x-admin-token');
            if (!await verifyToken(token)) {
                return { status: 401, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '認証が必要です' } };
            }

            const body = await request.json().catch(() => ({}));
            const { sldsslcd, dia_cd, b_day } = body;

            if (!sldsslcd && !dia_cd) {
                return { status: 400, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: 'sldsslcd または dia_cd は必須です' } };
            }

            const schema = process.env.PG_SCHEMA || 'public';
            const pool = getPgPool();

            // ① customer_master から顧客情報を取得
            // transfer_delete_flag = 0（移籍・削除なし）のみ対象
            let custQuery = `
                SELECT
                    salon_code, diana_code,
                    last_name_kanji, first_name_kanji,
                    last_name_kana, first_name_kana,
                    birth_date, registration_date,
                    transfer_delete_flag
                FROM ${schema}.customer_master
                WHERE transfer_delete_flag::text = '0'
            `;
            const params = [];

            if (dia_cd) {
                params.push(String(dia_cd));
                custQuery += ` AND diana_code::text = $${params.length}`;
            }
            if (sldsslcd) {
                params.push(String(sldsslcd));
                custQuery += ` AND salon_code::text = $${params.length}`;
            }
            if (b_day) {
                // 生年月日の形式を正規化（YYYY-MM-DD）
                const bdayNorm = b_day.replace(/\//g, '-');
                params.push(bdayNorm);
                custQuery += ` AND birth_date::text LIKE $${params.length} || '%'`;
            }
            custQuery += ' LIMIT 1';

            const custResult = await pool.query(custQuery, params);
            if (custResult.rows.length === 0) {
                return { status: 404, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: '顧客データが見つかりません' } };
            }
            const cust = custResult.rows[0];

            // ①-2 member_tblからGP倶楽部・ボディチェック情報を取得
            let member = null;
            try {
                const memberResult = await pool.query(`
                    SELECT
                        body_check_count,
                        last_body_check_date,
                        first_diagnosis_date,
                        gp_club_type,
                        gp_club_generation,
                        gp_club_expiration_date
                    FROM ${schema}.member_tbl
                    WHERE diana_cd::text = $1
                      AND delete_flag::text = '0'
                    LIMIT 1
                `, [String(cust.diana_code)]);
                if (memberResult.rows.length > 0) member = memberResult.rows[0];
            } catch (e) {
                context.log(`[diana-member] member_tbl取得エラー: ${e.message}`);
            }

            // ② body_checkから採寸データ取得
            const bodyCheckQuery = `
                SELECT
                    "ダイアナコード", "チェック日", "採寸フラグ", "採寸フラグ名",
                    "体重", "トップバスト", "アンダーバスト", "ウエスト",
                    "ミドルヒップ", "ヒップ",
                    "太もも左", "太もも右", "ふくらはぎ左", "ふくらはぎ右",
                    "アーム左", "アーム右", "体脂肪率", "PI", "BMI",
                    "チェック時身長", "チェック時年齢",
                    "サロン名", "氏名", "チーフ名",
                    "理想値_体重", "理想値_トップバスト", "理想値_アンダーバスト",
                    "理想値_ウエスト", "理想値_ミドルヒップ", "理想値_ヒップ",
                    "理想値_太もも左", "理想値_太もも右",
                    "理想値_ふくらはぎ左", "理想値_ふくらはぎ右",
                    "理想値_アーム左", "理想値_アーム右", "理想値_体脂肪率"
                FROM ${schema}.body_check
                WHERE "ダイアナコード"::text = $1
                ORDER BY "チェック日" ASC
            `;
            const bodyCheckResult = await pool.query(bodyCheckQuery, [String(cust.diana_code)]);
            const totalBodyCheck = bodyCheckResult.rows.length;
            const firstCheck = bodyCheckResult.rows[0] || null;       // 初回
            const latestCheck = bodyCheckResult.rows[totalBodyCheck - 1] || null; // 現在（最新）

            // サロン名（body_checkから取得）
            const salonName = latestCheck?.['サロン名'] || firstCheck?.['サロン名'] || null;

            // ③ ダイアナ歴（registration_date から計算）
            let dianaYears = null;
            if (cust.registration_date) {
                const regDate = new Date(cust.registration_date);
                const now = new Date();
                dianaYears = Math.floor((now - regDate) / (1000 * 60 * 60 * 24 * 365));
            }

            // 変化値を計算（現在 - 初回）
            const calcDiff = (field) => {
                const first = firstCheck?.[field];
                const latest = latestCheck?.[field];
                if (first == null || latest == null) return null;
                return Math.round((parseFloat(latest) - parseFloat(first)) * 10) / 10;
            };

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                jsonBody: {
                    // 顧客情報（customer_masterから取得）
                    salon_code:        cust.salon_code,
                    salon_name:        salonName,
                    dia_cd:            cust.diana_code,
                    name_kanji:        (cust.last_name_kanji || '') + ' ' + (cust.first_name_kanji || ''),
                    name_kana:         (cust.last_name_kana  || '') + ' ' + (cust.first_name_kana  || ''),
                    b_day:             cust.birth_date,
                    diana_years:       dianaYears,
                    age:               cust.birth_date ? Math.floor((new Date() - new Date(cust.birth_date)) / (1000 * 60 * 60 * 24 * 365.25)) : null,
                    registration_date: cust.registration_date,
                    // member_tblから取得
                    total_body_check:  member?.body_check_count || totalBodyCheck,
                    last_body_check_date: member?.last_body_check_date || null,
                    first_diagnosis_date: member?.first_diagnosis_date || null,
                    gp_club_type:      member?.gp_club_type || null,
                    gp_club_generation: member?.gp_club_generation || null,
                    gp_club_expiration_date: member?.gp_club_expiration_date || null,
                    // 初回採寸
                    first_check_date:  firstCheck?.['チェック日'] || null,
                    first_height:      firstCheck?.['チェック時身長'] || null,
                    first_weight:      firstCheck?.['体重'] || null,
                    first_top_bust:    firstCheck?.['トップバスト'] || null,
                    first_under_bust:  firstCheck?.['アンダーバスト'] || null,
                    first_waist:       firstCheck?.['ウエスト'] || null,
                    first_mid_hip:     firstCheck?.['ミドルヒップ'] || null,
                    first_hip:         firstCheck?.['ヒップ'] || null,
                    first_thigh_l:     firstCheck?.['太もも左'] || null,
                    first_thigh_r:     firstCheck?.['太もも右'] || null,
                    first_calf_l:      firstCheck?.['ふくらはぎ左'] || null,
                    first_calf_r:      firstCheck?.['ふくらはぎ右'] || null,
                    first_arm_l:       firstCheck?.['アーム左'] || null,
                    first_arm_r:       firstCheck?.['アーム右'] || null,
                    first_fat:         firstCheck?.['体脂肪率'] || null,
                    first_bmi:         firstCheck?.['BMI'] || null,
                    first_pi:          firstCheck?.['PI'] || null,
                    first_age:         firstCheck?.['チェック時年齢'] || null,
                    // 現在採寸（最新）
                    latest_check_date: latestCheck?.['チェック日'] || null,
                    latest_height:     latestCheck?.['チェック時身長'] || null,
                    latest_weight:     latestCheck?.['体重'] || null,
                    latest_top_bust:   latestCheck?.['トップバスト'] || null,
                    latest_under_bust: latestCheck?.['アンダーバスト'] || null,
                    latest_waist:      latestCheck?.['ウエスト'] || null,
                    latest_mid_hip:    latestCheck?.['ミドルヒップ'] || null,
                    latest_hip:        latestCheck?.['ヒップ'] || null,
                    latest_thigh_l:    latestCheck?.['太もも左'] || null,
                    latest_thigh_r:    latestCheck?.['太もも右'] || null,
                    latest_calf_l:     latestCheck?.['ふくらはぎ左'] || null,
                    latest_calf_r:     latestCheck?.['ふくらはぎ右'] || null,
                    latest_arm_l:      latestCheck?.['アーム左'] || null,
                    latest_arm_r:      latestCheck?.['アーム右'] || null,
                    latest_fat:        latestCheck?.['体脂肪率'] || null,
                    latest_bmi:        latestCheck?.['BMI'] || null,
                    latest_pi:         latestCheck?.['PI'] || null,
                    latest_age:        latestCheck?.['チェック時年齢'] || null,
                    // 変化値（現在 - 初回）
                    diff_weight:       calcDiff('体重'),
                    diff_top_bust:     calcDiff('トップバスト'),
                    diff_under_bust:   calcDiff('アンダーバスト'),
                    diff_waist:        calcDiff('ウエスト'),
                    diff_mid_hip:      calcDiff('ミドルヒップ'),
                    diff_hip:          calcDiff('ヒップ'),
                    diff_thigh_l:      calcDiff('太もも左'),
                    diff_thigh_r:      calcDiff('太もも右'),
                    diff_fat:          calcDiff('体脂肪率'),
                    diff_bmi:          calcDiff('BMI'),
                    diff_pi:           calcDiff('PI'),
                    // 理想値（最新チェックから取得）
                    ideal_weight:      latestCheck?.['理想値_体重'] || null,
                    ideal_top_bust:    latestCheck?.['理想値_トップバスト'] || null,
                    ideal_under_bust:  latestCheck?.['理想値_アンダーバスト'] || null,
                    ideal_waist:       latestCheck?.['理想値_ウエスト'] || null,
                    ideal_mid_hip:     latestCheck?.['理想値_ミドルヒップ'] || null,
                    ideal_hip:         latestCheck?.['理想値_ヒップ'] || null,
                    ideal_thigh_l:     latestCheck?.['理想値_太もも左'] || null,
                    ideal_thigh_r:     latestCheck?.['理想値_太もも右'] || null,
                    ideal_calf_l:      latestCheck?.['理想値_ふくらはぎ左'] || null,
                    ideal_calf_r:      latestCheck?.['理想値_ふくらはぎ右'] || null,
                    ideal_fat:         latestCheck?.['理想値_体脂肪率'] || null,
                }
            };

        } catch (e) {
            context.log(`[diana-member] エラー: ${e.message}`);
            return { status: 500, headers: { 'Content-Type': 'application/json' }, jsonBody: { error: e.message } };
        }
    }
});