require('dotenv').config();
const express = require('express');
const { CosmosClient } = require('@azure/cosmos');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));


// ----------------------------------------------------
// 🔒 セキュリティヘッダー共通設定
// ----------------------------------------------------
app.use(function(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cache-Control', 'no-store');
    next();
});

// ----------------------------------------------------
// 🔑 トークン管理（Cosmos DB永続化）
// ----------------------------------------------------
async function getContainer() {
    const client = new CosmosClient(process.env.COSMOS_CONNECTION);
    return client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
}

async function issueToken() {
    const container = await getContainer();
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await container.items.upsert({
        id: 'token_' + token,
        docType: 'auth_token',
        tenant: 'auth_token',
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
// 認証
// ----------------------------------------------------
app.post('/api/auth', async (req, res) => {
    const { password, tenant } = req.body;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    const envKey = 'ADMIN_PASSWORD_' + tenant.toUpperCase().replace(/-/g, '_');
    const correctPW = process.env[envKey];
    if (!correctPW) return res.status(401).json({ error: 'このテナントは設定されていません' });

    const container = await getContainer();

    if (password === correctPW) {
        const token = await issueToken();
        await container.items.create({ id: crypto.randomUUID(), docType: 'access_log', tenant, result: 'success', ip: req.ip || 'localhost', createdAt: new Date().toISOString() }).catch(() => {});
        return res.json({ token });
    }
    await container.items.create({ id: crypto.randomUUID(), docType: 'access_log', tenant, result: 'failure', ip: req.ip || 'localhost', createdAt: new Date().toISOString() }).catch(() => {});
    res.status(401).json({ error: 'パスワードが違います' });
});

// ----------------------------------------------------
// 期間取得・保存
// ----------------------------------------------------
app.get('/api/period', async (req, res) => {
    const { tenant, surveyId } = req.query;
    if (!tenant && !surveyId) return res.status(400).json({ error: 'tenant または surveyId は必須です' });
    try {
        const container = await getContainer();
        const id = surveyId ? 'period_survey_' + surveyId : 'period_' + tenant;
        const pk = surveyId ? 'survey_period' : tenant;
        const { resource } = await container.item(id, pk).read();
        return res.json({ startDate: resource ? resource.startDate : null, endDate: resource ? resource.endDate : null });
    } catch (e) { return res.json({ startDate: null, endDate: null }); }
});

app.post('/api/period', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { tenant, surveyId, startDate, endDate } = req.body;
    try {
        const container = await getContainer();
        const id = surveyId ? 'period_survey_' + surveyId : 'period_' + tenant;
        const pk = surveyId ? 'survey_period' : tenant;
        await container.items.upsert({ id, tenant: pk, startDate: startDate || null, endDate: endDate || null, updatedAt: new Date().toISOString() });
        return res.json({ status: 'ok', startDate, endDate });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------
// アンケート定義 CRUD
// ----------------------------------------------------
app.get('/api/surveys', async (req, res) => {
    const { tenant, id } = req.query;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        if (id) { const { resource } = await container.item(id, tenant).read(); return res.json(resource); }
        const { resources } = await container.items.query({
            query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_definition' ORDER BY c.createdAt DESC",
            parameters: [{ name: "@tenant", value: tenant }]
        }).fetchAll();
        return res.json(resources);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post('/api/surveys', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { tenant, title, description, questions, active, thanksMessage } = req.body;
    if (!tenant || !title) return res.status(400).json({ error: 'tenant と title は必須です' });
    try {
        const container = await getContainer();
        const newSurvey = {
            id: 'survey_' + crypto.randomUUID(), docType: 'survey_definition',
            tenant, title, description: description || '', questions: questions || [],
            active: active !== undefined ? active : true,
            thanksMessage: thanksMessage || '',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
        };
        await container.items.create(newSurvey);
        return res.status(201).json(newSurvey);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.put('/api/surveys', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { id, tenant, title, description, questions, active, thanksMessage } = req.body;
    if (!id || !tenant) return res.status(400).json({ error: 'id と tenant は必須です' });
    try {
        const container = await getContainer();
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
        return res.json(updated);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.delete('/api/surveys', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { id, tenant } = req.query;
    if (!id || !tenant) return res.status(400).json({ error: 'id と tenant は必須です' });
    try {
        const container = await getContainer();
        await container.item(id, tenant).delete();
        return res.json({ status: 'deleted' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------
// 回答データ
// ----------------------------------------------------
app.post('/api/response', async (req, res) => {
    const { surveyId, tenant, answers } = req.body;
    if (!surveyId || !tenant || !answers) return res.status(400).json({ error: 'surveyId, tenant, answers は必須です' });
    try {
        const container = await getContainer();

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
                console.log(`[重複メールスキップ] tenant=${tenant} surveyId=${surveyId} email=${emailAnswer.trim()}`);
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
            id: crypto.randomUUID(),
            docType: 'survey_response',
            surveyId, tenant, answers,
            emailAddress: emailAnswer ? emailAnswer.trim().toLowerCase() : null,
            createdAt: new Date().toISOString()
        });
        return res.status(201).json({ status: 'ok' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get('/api/response', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { surveyId, tenant } = req.query;
    if (!surveyId || !tenant) return res.status(400).json({ error: 'surveyId と tenant は必須です' });
    try {
        const container = await getContainer();
        const { resources } = await container.items.query({
            query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.surveyId = @surveyId AND c.docType = 'survey_response' ORDER BY c.createdAt DESC",
            parameters: [{ name: "@tenant", value: tenant }, { name: "@surveyId", value: surveyId }]
        }).fetchAll();
        return res.json(resources);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.delete('/api/response', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { id, tenant } = req.query;
    if (!id || !tenant) return res.status(400).json({ error: 'id と tenant は必須です' });
    try {
        const container = await getContainer();
        await container.item(id, tenant).delete();
        return res.json({ status: 'deleted' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------
// アクセスログ取得
// ----------------------------------------------------
app.get('/api/accesslog', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { tenant } = req.query;
    try {
        const container = await getContainer();
        let query = "SELECT TOP 200 * FROM c WHERE c.docType = 'access_log' ORDER BY c.createdAt DESC";
        let parameters = [];
        if (tenant) { query = "SELECT TOP 200 * FROM c WHERE c.docType = 'access_log' AND c.tenant = @tenant ORDER BY c.createdAt DESC"; parameters = [{ name: "@tenant", value: tenant }]; }
        const { resources } = await container.items.query({ query, parameters }).fetchAll();
        return res.json(resources);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------
// 回答数サマリー（GROUP BY非依存）
// ----------------------------------------------------
app.post('/api/responsecounts', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { tenant, surveyIds } = req.body;
    if (!tenant || !surveyIds) return res.status(400).json({ error: 'tenant と surveyIds は必須です' });
    try {
        const container = await getContainer();
        const counts = {};
        surveyIds.forEach(id => counts[id] = 0);
        const { resources } = await container.items.query({
            query: "SELECT c.surveyId FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_response' AND ARRAY_CONTAINS(@ids, c.surveyId)",
            parameters: [{ name: "@tenant", value: tenant }, { name: "@ids", value: surveyIds }]
        }).fetchAll();
        resources.forEach(r => { if (counts[r.surveyId] !== undefined) counts[r.surveyId]++; });
        return res.json(counts);
    } catch (e) { return res.json({}); }
});


// ----------------------------------------------------
// 🎨 デザイン設定（テナント共通 & アンケートごと）
// ----------------------------------------------------
app.get('/api/tenantsettings', async (req, res) => {
    const { tenant, surveyId } = req.query;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        if (surveyId) {
            try {
                const { resource } = await container.item('design_' + surveyId, tenant).read();
                if (resource) return res.json({ ...resource, _source: 'survey' });
            } catch (e) {}
        }
        try {
            const { resource } = await container.item('settings_' + tenant, tenant).read();
            return res.json({ ...(resource || {}), _source: 'tenant' });
        } catch (e) { return res.json({ _source: 'none' }); }
    } catch (e) { return res.json({}); }
});

app.post('/api/tenantsettings', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { tenant, surveyId, logoBase64, logoName, headerColor, bgColor, bgType, privacyText, privacyLinkText, privacyLinkUrl, privacyTextColor, privacyBgColor } = req.body;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        const id = surveyId ? 'design_' + surveyId : 'settings_' + tenant;
        const existing = await container.item(id, tenant).read().then(r => r.resource || {}).catch(() => ({}));
        const updated = {
            ...existing, id,
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
        return res.json(updated);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});


// ----------------------------------------------------
// 🔮 診断（複数診断対応）
// ----------------------------------------------------
app.get('/api/diagnosislist', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { tenant } = req.query;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        const { resources } = await container.items.query({
            query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.docType = 'diagnosis' ORDER BY c.updatedAt DESC",
            parameters: [{ name: "@tenant", value: tenant }]
        }).fetchAll();
        return res.json(resources);
    } catch (e) { return res.json([]); }
});

app.get('/api/diagnosis', async (req, res) => {
    const { tenant, diagId, id } = req.query;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        const dId = diagId || id;
        if (dId) {
            const { resource } = await container.item(dId, tenant).read();
            return res.json(resource || {});
        }
        const { resources } = await container.items.query({
            query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.docType = 'diagnosis' ORDER BY c.updatedAt DESC OFFSET 0 LIMIT 1",
            parameters: [{ name: "@tenant", value: tenant }]
        }).fetchAll();
        return res.json(resources[0] || { questions: [], results: {} });
    } catch (e) { return res.json({ questions: [], results: {} }); }
});

app.post('/api/diagnosis', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const body = req.body;
    const { tenant, diagId, title, description, questions, results } = body;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        const id = diagId || ('diag_' + crypto.randomUUID());
        const updated = { ...body, id, diagId: id, docType: 'diagnosis', tenant, title: title || '', description: description || '', questions: questions || [], results: results || {}, updatedAt: new Date().toISOString() };
        await container.items.upsert(updated);
        return res.json(updated);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.delete('/api/diagnosis', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { id, diagId, tenant } = req.query;
    const dId = id || diagId;
    if (!dId || !tenant) return res.status(400).json({ error: 'id と tenant は必須です' });
    try {
        const container = await getContainer();
        await container.item(dId, tenant).delete();
        return res.json({ status: 'deleted' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});


// ----------------------------------------------------
// 📧 メール設定
// ----------------------------------------------------
app.get('/api/emailsettings', async (req, res) => {
    const { tenant, surveyId } = req.query;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        const id = surveyId ? 'emailsettings_' + surveyId : 'emailsettings_tenant_' + tenant;
        try {
            const { resource } = await container.item(id, tenant).read();
            return res.json(resource || { emailEnabled: false });
        } catch (e) {
            return res.json({ emailEnabled: false });
        }
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post('/api/emailsettings', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { tenant, surveyId, emailEnabled, subject, bodyText, senderName } = req.body;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        const id = surveyId ? 'emailsettings_' + surveyId : 'emailsettings_tenant_' + tenant;
        const existing = await container.item(id, tenant).read().then(r => r.resource || {}).catch(() => ({}));
        const updated = {
            ...existing, id,
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
        return res.json(updated);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------
// 📨 メール送信ログ取得
// ----------------------------------------------------
app.get('/api/emaillog', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { tenant, surveyId } = req.query;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
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
        return res.json(resources);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});


// ----------------------------------------------------
// 📊 診断結果ログ
// ----------------------------------------------------
app.post('/api/diagnosislog', async (req, res) => {
    const { tenant, resultKey, resultTitle, diagTitle, diagId } = req.body;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        await container.items.create({ id: crypto.randomUUID(), docType: 'diagnosis_log', tenant, resultKey, resultTitle, diagTitle: diagTitle || '', diagId: diagId || '', createdAt: new Date().toISOString() });
        return res.status(201).json({ status: 'ok' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get('/api/diagnosislog', async (req, res) => {
    if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    const { tenant } = req.query;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const container = await getContainer();
        const { resources } = await container.items.query({
            query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.docType = 'diagnosis_log' ORDER BY c.createdAt DESC OFFSET 0 LIMIT 500",
            parameters: [{ name: "@tenant", value: tenant }]
        }).fetchAll();
        return res.json(resources);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------
// 既存ログ互換
// ----------------------------------------------------
app.all('/api/log', async (req, res) => {
    if (req.method === 'GET' || req.method === 'DELETE') {
        if (!await verifyToken(req.headers['x-admin-token'])) return res.status(401).json({ error: '認証が必要です' });
    }
    try {
        const container = await getContainer();
        if (req.method === 'DELETE') { const { id, tenant } = req.query; await container.item(id, tenant).delete(); return res.json({ status: 'deleted' }); }
        if (req.method === 'GET') {
            const { tenant, type } = req.query;
            const { resources } = await container.items.query({ query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.type = @type", parameters: [{ name: "@tenant", value: tenant }, { name: "@type", value: type }] }).fetchAll();
            return res.json(resources);
        }
        const { tenant, type, data } = req.body;
        await container.items.create({ id: crypto.randomUUID(), tenant, type, ...data, createdAt: new Date().toISOString() });
        res.status(201).json({ status: 'ok' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ----------------------------------------------------
// 起動
// ----------------------------------------------------
app.listen(7071, () => {
    console.log('');
    console.log('✅ ローカルサーバー起動中');
    console.log('──────────────────────────────────────────');
    console.log('ポータル:               http://localhost:7071/index.html');
    console.log('Herbelleダッシュボード: http://localhost:7071/dashboard-herbelle.html');
    console.log('Dianaダッシュボード:    http://localhost:7071/dashboard-diana.html');
    console.log('アンケート(動的):       http://localhost:7071/survey.html?id=xxx&tenant=yyy');
    console.log('──────────────────────────────────────────');
    console.log('停止するには Ctrl+C を押してください');
    console.log('');
});