require('dotenv').config();
const express = require('express');
const { CosmosClient } = require('@azure/cosmos');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

const validTokens = new Set();

// 認証
app.post('/api/auth', async (req, res) => {
    const { password, tenant } = req.body;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    const envKey = 'ADMIN_PASSWORD_' + tenant.toUpperCase().replace(/-/g, '_');
    const correctPW = process.env[envKey];
    if (!correctPW) return res.status(401).json({ error: 'このテナントは設定されていません' });

    const client = new CosmosClient(process.env.COSMOS_CONNECTION);
    const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);

    if (password === correctPW) {
        const token = crypto.randomBytes(16).toString('hex');
        validTokens.add(token);
        setTimeout(() => validTokens.delete(token), 24 * 60 * 60 * 1000);
        // アクセスログ記録（成功）
        await container.items.create({ id: crypto.randomUUID(), docType: 'access_log', tenant, result: 'success', ip: req.ip || 'localhost', createdAt: new Date().toISOString() }).catch(() => {});
        return res.json({ token });
    }
    // アクセスログ記録（失敗）
    await container.items.create({ id: crypto.randomUUID(), docType: 'access_log', tenant, result: 'failure', ip: req.ip || 'localhost', createdAt: new Date().toISOString() }).catch(() => {});
    res.status(401).json({ error: 'パスワードが違います' });
});

// 期間取得・保存
app.get('/api/period', async (req, res) => {
    const { tenant, surveyId } = req.query;
    if (!tenant && !surveyId) return res.status(400).json({ error: 'tenant または surveyId は必須です' });
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
        const id = surveyId ? 'period_survey_' + surveyId : 'period_' + tenant;
        const pk = surveyId ? 'survey_period' : tenant;
        const { resource } = await container.item(id, pk).read();
        return res.json({ startDate: resource ? resource.startDate : null, endDate: resource ? resource.endDate : null });
    } catch (e) { return res.json({ startDate: null, endDate: null }); }
});

app.post('/api/period', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) return res.status(401).json({ error: '認証が必要です' });
    const { tenant, surveyId, startDate, endDate } = req.body;
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
        const id = surveyId ? 'period_survey_' + surveyId : 'period_' + tenant;
        const pk = surveyId ? 'survey_period' : tenant;
        await container.items.upsert({ id, tenant: pk, startDate: startDate || null, endDate: endDate || null, updatedAt: new Date().toISOString() });
        return res.json({ status: 'ok', startDate, endDate });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// アンケート定義 CRUD
app.get('/api/surveys', async (req, res) => {
    const { tenant, id } = req.query;
    if (!tenant) return res.status(400).json({ error: 'tenant は必須です' });
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
        if (id) { const { resource } = await container.item(id, tenant).read(); return res.json(resource); }
        const { resources } = await container.items.query({
            query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_definition' ORDER BY c.createdAt DESC",
            parameters: [{ name: "@tenant", value: tenant }]
        }).fetchAll();
        return res.json(resources);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.post('/api/surveys', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) return res.status(401).json({ error: '認証が必要です' });
    const { tenant, title, description, questions, active, thanksMessage } = req.body;
    if (!tenant || !title) return res.status(400).json({ error: 'tenant と title は必須です' });
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
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
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) return res.status(401).json({ error: '認証が必要です' });
    const { id, tenant, title, description, questions, active, thanksMessage } = req.body;
    if (!id || !tenant) return res.status(400).json({ error: 'id と tenant は必須です' });
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
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
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) return res.status(401).json({ error: '認証が必要です' });
    const { id, tenant } = req.query;
    if (!id || !tenant) return res.status(400).json({ error: 'id と tenant は必須です' });
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
        await container.item(id, tenant).delete();
        return res.json({ status: 'deleted' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// 回答データ
app.post('/api/response', async (req, res) => {
    const { surveyId, tenant, answers } = req.body;
    if (!surveyId || !tenant || !answers) return res.status(400).json({ error: 'surveyId, tenant, answers は必須です' });
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
        await container.items.create({ id: crypto.randomUUID(), docType: 'survey_response', surveyId, tenant, answers, createdAt: new Date().toISOString() });
        return res.status(201).json({ status: 'ok' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.get('/api/response', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) return res.status(401).json({ error: '認証が必要です' });
    const { surveyId, tenant } = req.query;
    if (!surveyId || !tenant) return res.status(400).json({ error: 'surveyId と tenant は必須です' });
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
        const { resources } = await container.items.query({
            query: "SELECT * FROM c WHERE c.tenant = @tenant AND c.surveyId = @surveyId AND c.docType = 'survey_response' ORDER BY c.createdAt DESC",
            parameters: [{ name: "@tenant", value: tenant }, { name: "@surveyId", value: surveyId }]
        }).fetchAll();
        return res.json(resources);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

app.delete('/api/response', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) return res.status(401).json({ error: '認証が必要です' });
    const { id, tenant } = req.query;
    if (!id || !tenant) return res.status(400).json({ error: 'id と tenant は必須です' });
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
        await container.item(id, tenant).delete();
        return res.json({ status: 'deleted' });
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// アクセスログ取得
app.get('/api/accesslog', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) return res.status(401).json({ error: '認証が必要です' });
    const { tenant } = req.query;
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
        let query = "SELECT TOP 200 * FROM c WHERE c.docType = 'access_log' ORDER BY c.createdAt DESC";
        let parameters = [];
        if (tenant) { query = "SELECT TOP 200 * FROM c WHERE c.docType = 'access_log' AND c.tenant = @tenant ORDER BY c.createdAt DESC"; parameters = [{ name: "@tenant", value: tenant }]; }
        const { resources } = await container.items.query({ query, parameters }).fetchAll();
        return res.json(resources);
    } catch (e) { return res.status(500).json({ error: e.message }); }
});

// 回答数サマリー
app.post('/api/responsecounts', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || !validTokens.has(token)) return res.status(401).json({ error: '認証が必要です' });
    const { tenant, surveyIds } = req.body;
    if (!tenant || !surveyIds) return res.status(400).json({ error: 'tenant と surveyIds は必須です' });
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
        const counts = {};
        surveyIds.forEach(id => counts[id] = 0);
        const { resources } = await container.items.query({
            query: "SELECT c.surveyId, COUNT(1) as cnt FROM c WHERE c.tenant = @tenant AND c.docType = 'survey_response' AND ARRAY_CONTAINS(@ids, c.surveyId) GROUP BY c.surveyId",
            parameters: [{ name: "@tenant", value: tenant }, { name: "@ids", value: surveyIds }]
        }).fetchAll();
        resources.forEach(r => { counts[r.surveyId] = r.cnt; });
        return res.json(counts);
    } catch (e) { return res.json({}); }
});

// 既存ログ互換
app.all('/api/log', async (req, res) => {
    if (req.method === 'GET' || req.method === 'DELETE') {
        const token = req.headers['x-admin-token'];
        if (!token || !validTokens.has(token)) return res.status(401).json({ error: '認証が必要です' });
    }
    try {
        const client = new CosmosClient(process.env.COSMOS_CONNECTION);
        const container = client.database(process.env.COSMOS_DATABASE).container(process.env.COSMOS_CONTAINER);
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
