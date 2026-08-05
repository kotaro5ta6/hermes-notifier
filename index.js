// エルメス新商品チェッカー
// 各カテゴリページを取得し、前回とのSKU差分から新商品を検出してLINEに通知します。

const fs = require('fs');
const path = require('path');

const CATEGORIES = require('./categories.json');
const STATE_FILE = path.join(__dirname, 'state.json');
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEBUG_DIR = path.join(__dirname, 'debug-output');

// 失敗した瞬間の画面を、あとで確認できるように保存する
async function saveDebugSnapshot(page, categoryUrl) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }
    const slug = categoryUrl.replace(/[^a-zA-Z0-9]/g, '_').slice(-60);
    const screenshotPath = path.join(DEBUG_DIR, `${slug}.png`);
    const htmlPath = path.join(DEBUG_DIR, `${slug}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const html = await page.content();
    fs.writeFileSync(htmlPath, html);

    console.log(`[デバッグ] 失敗時の画面を保存しました: ${screenshotPath}`);
  } catch (e) {
    console.warn('[デバッグ] スナップショットの保存に失敗しました:', e.message);
  }
}

// ページを開き、「もっと見る」ボタンがある限りクリックして全商品を読み込んでから
// 埋め込みJSON(hermes-state)を取り出す
// browser: main()で1回だけ起動したものを毎回使い回す（起動コストを減らすため）
async function fetchProducts(browser, categoryUrl) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (compatible; PersonalStockChecker/1.0; +for personal use)'
    );
    await page.goto(categoryUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    // 安全のため最大20回まで。それでも終わらない異常系は諦めて今ある分で進める
    for (let i = 0; i < 20; i++) {
      const button = await page.$('[data-testid="Load more items"]');
      if (!button) break;

      try {
        const box = await button.boundingBox();
        if (!box) break; // 非表示 = もう「もっと見る」は無い
        await button.click();
      } catch (clickErr) {
        // ボタンがクリックの瞬間に消えた・入れ替わったなど。
        // ここで諦めてカテゴリ全体を失敗にせず、今読み込めている分で進める
        console.warn(
          `[${categoryUrl}] 「もっと見る」のクリックに失敗したため、ここまでの分で進めます: ${clickErr.message}`
        );
        break;
      }
      await sleep(1500); // 追加読み込みを待つ
    }

    const stateJson = await page.evaluate(() => {
      const el = document.getElementById('hermes-state');
      return el ? el.textContent : null;
    });

    if (!stateJson) {
      // 原因調査のため、失敗した瞬間の画面をスクリーンショットとHTMLで保存しておく
      await saveDebugSnapshot(page, categoryUrl);
      throw new Error(
        '商品データ(hermes-state)が見つかりませんでした。ページ構造が変わった可能性があります。'
      );
    }

    const data = JSON.parse(stateJson);
    const products = [];
    const seenSkus = new Set();

    function walk(obj) {
      if (Array.isArray(obj)) {
        obj.forEach(walk);
      } else if (obj && typeof obj === 'object') {
        if (obj.sku && obj.title && obj.url && !seenSkus.has(obj.sku)) {
          seenSkus.add(obj.sku);
          products.push({ sku: obj.sku, title: obj.title, url: obj.url });
        }
        Object.values(obj).forEach(walk);
      }
    }
    walk(data);

    let declaredTotal = null;
    (function findTotal(obj) {
      if (declaredTotal !== null) return;
      if (obj && typeof obj === 'object') {
        if (obj.total && obj.products && obj.products.items) {
          declaredTotal = obj.total;
          return;
        }
        Object.values(obj).forEach(findTotal);
      }
    })(data);

    if (declaredTotal !== null && products.length < declaredTotal) {
      console.warn(
        `[警告] ${categoryUrl} : サイト側の総数は${declaredTotal}件ですが、${products.length}件しか取得できませんでした（「もっと見る」ボタンをクリックしきれなかった可能性があります）。`
      );
    }

    return products;
  } finally {
    await page.close();
  }
}

// LINE公式アカウントの友だち全員にメッセージを送信する
async function sendLineBroadcast(text) {
  if (!LINE_TOKEN) {
    console.log('[通知スキップ] LINE_CHANNEL_ACCESS_TOKENが設定されていません。');
    console.log('送信予定だった内容:', text);
    return;
  }

  const res = await fetch('https://api.line.me/v2/bot/message/broadcast', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LINE_TOKEN}`
    },
    body: JSON.stringify({
      messages: [{ type: 'text', text }]
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`LINE通知に失敗しました (${res.status}): ${body}`);
  }
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  return {};
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// 一時的な失敗（サイトの読み込みタイミングのズレなど）に備えて、
// 1回失敗しても10秒待ってからもう1回だけ試す
async function fetchProductsWithRetry(browser, categoryUrl, categoryName) {
  try {
    return await fetchProducts(browser, categoryUrl);
  } catch (err) {
    console.warn(`[${categoryName}] 1回目の取得に失敗、10秒後に再試行します:`, err.message);
    await sleep(10000);
    return await fetchProducts(browser, categoryUrl);
  }
}

async function main() {
  const state = loadState();
  let hadError = false;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    for (const category of CATEGORIES) {
      try {
        const products = await fetchProductsWithRetry(browser, category.url, category.name);
        const knownSkus = new Set(state[category.name] || []);
        const isFirstRun = !state[category.name];
        const newProducts = products.filter((p) => !knownSkus.has(p.sku));

        console.log(
          `[${category.name}] 商品数: ${products.length}件 / 新規: ${
            isFirstRun ? '(初回のため通知なし)' : newProducts.length + '件'
          }`
        );

        // 初回実行時は「今ある商品」を基準として保存するだけで、通知はしない
        // (そうしないと既存の全商品が「新商品」として通知されてしまうため)
        if (!isFirstRun) {
          for (const product of newProducts) {
            const fullUrl = encodeURI(`https://www.hermes.com/jp/ja${product.url}`);
            const message = `【新商品】${category.name}\n${product.title}\n${fullUrl}`;
            console.log('通知送信:', message);
            await sendLineBroadcast(message);
            await sleep(1000); // LINEへの連続送信を避ける
          }
        }

        state[category.name] = products.map((p) => p.sku);
      } catch (err) {
        hadError = true;
        console.error(`[${category.name}] エラー:`, err.message);
      }

      // カテゴリごとに間隔をあけて、サイトへの負荷を抑える
      await sleep(2000);
    }
  } finally {
    await browser.close();
  }

  saveState(state);

  if (hadError) {
    process.exitCode = 1;
  }
}

main();
