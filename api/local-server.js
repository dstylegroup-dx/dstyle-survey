// ローカル確認用サーバー（本番では使わない）
//
// 本番と同じ処理（src/functions/index.js）をそのまま動かし、
// 画面のURLの扱いも staticwebapp.config.json に合わせる。
// API を追加・変更しても、このファイルを直す必要はない。
//
// ⚠️ 接続先は api/.env の設定に従う。本番のデータベースを指している場合、
//    ローカルでの保存・送信は本番のデータを変更する。
//
// 起動：cd api && node local-server.js  →  http://localhost:7071

const fs = require('fs');
const path = require('path');
const Module = require('module');
const express = require('express');

const PORT = 7071;
const ROOT = path.join(__dirname, '..');

// ----------------------------------------------------
// 本番の関数定義を読み込む
// ----------------------------------------------------
// index.js が呼ぶ app.http() を記録し、Express のルートとして登録する。
// app.timer()（定期メール・定期レポートなど）はローカルでは動かさない。
const httpFunctions = [];
const fakeFunctions = {
    app: {
        http: (name, options) => httpFunctions.push({ name, ...options }),
        timer: () => {},
        setup: () => {}
    }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@azure/functions') return fakeFunctions;
    return originalLoad.call(this, request, ...rest);
};
require('./src/functions/index.js');
Module._load = originalLoad;

const app = express();

// ----------------------------------------------------
// API
// ----------------------------------------------------
app.use('/api', express.text({ type: () => true, limit: '50mb' }));

function toAzureRequest(req) {
    const rawBody = typeof req.body === 'string' ? req.body : '';
    const url = new URL(req.originalUrl, `http://${req.headers.host}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    return {
        method: req.method,
        url: url.toString(),
        headers,
        query: url.searchParams,
        params: { ...req.params },
        text: async () => rawBody,
        json: async () => JSON.parse(rawBody)
    };
}

const context = {
    log: console.log, info: console.info, warn: console.warn,
    error: console.error, debug: console.debug, trace: console.trace
};

function sendAzureResponse(res, result) {
    const r = result || {};
    res.status(r.status || 200);
    for (const [key, value] of Object.entries(r.headers || {})) res.setHeader(key, value);
    if (r.jsonBody !== undefined) {
        if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json');
        res.send(JSON.stringify(r.jsonBody));
    } else if (r.body !== undefined && r.body !== null) {
        res.send(r.body);
    } else {
        res.end();
    }
}

for (const fn of httpFunctions) {
    const route = '/api/' + (fn.route || fn.name).replace(/\{(\w+)\}/g, ':$1');
    const methods = (fn.methods || ['GET', 'POST']).map(m => m.toLowerCase());
    for (const method of methods) {
        app[method](route, async (req, res) => {
            try {
                sendAzureResponse(res, await fn.handler(toAzureRequest(req), context));
            } catch (e) {
                console.error(`[${fn.name}]`, e);
                res.status(500).json({ error: e.message });
            }
        });
    }
}
app.use('/api', (req, res) => res.status(404).json({ error: 'Not Found' }));

// ----------------------------------------------------
// 画面（staticwebapp.config.json に合わせる）
// ----------------------------------------------------
const swaConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'staticwebapp.config.json'), 'utf8'));

app.use((req, res, next) => {
    for (const [key, value] of Object.entries(swaConfig.globalHeaders || {})) {
        // localhost は http なので HSTS は付けない
        if (key.toLowerCase() !== 'strict-transport-security') res.setHeader(key, value);
    }
    next();
});

for (const r of swaConfig.routes || []) {
    if (r.route.includes('*')) continue;
    app.get(r.route, (req, res, next) => {
        for (const [key, value] of Object.entries(r.headers || {})) res.setHeader(key, value);
        if (r.redirect) {
            const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
            return res.redirect(r.statusCode || 302, r.redirect + query);
        }
        if (r.rewrite) return res.sendFile(r.rewrite, { root: ROOT });
        next();
    });
}

// api/ 以下（.env やサーバーのコード）は画面として配信しない
app.use('/api', (req, res) => res.status(404).end());
app.use(express.static(ROOT, { dotfiles: 'ignore' }));

// 該当するファイルがない画面URLは index.html を返す（navigationFallback）
const fallback = swaConfig.navigationFallback;
if (fallback) {
    const excludes = (fallback.exclude || []).map(p =>
        new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
    app.get(/.*/, (req, res, next) => {
        if (excludes.some(re => re.test(req.path))) return next();
        res.sendFile(fallback.rewrite, { root: ROOT });
    });
}

app.listen(PORT, 'localhost', () => {
    console.log(`ローカルサーバー起動: http://localhost:${PORT}`);
    console.log(`API ${httpFunctions.length} 件を読み込みました`);
});
