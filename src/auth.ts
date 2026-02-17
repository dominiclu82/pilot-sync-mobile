import fs from 'fs';
import path from 'path';
import { google } from 'googleapis';
import http from 'http';
import url from 'url';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname_local = dirname(__filename);
const ROOT = path.join(__dirname_local, '..');

const TOKEN_PATH = path.join(ROOT, 'token.json');
const CREDENTIALS_PATH = path.join(ROOT, 'credentials.json');
const CALLBACK_PORT = 5174;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/api/oauth2callback`;

async function getNewToken() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error('❌ 找不到 credentials.json');
    console.error('   請將原專案的 backend/credentials.json 複製到此資料夾根目錄');
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const oauth2Client = new google.auth.OAuth2(
    credentials.web.client_id,
    credentials.web.client_secret,
    REDIRECT_URI
  );

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent',
  });

  console.log('\n🔐 Google Calendar 授權流程');
  console.log('─'.repeat(50));
  console.log('請用瀏覽器開啟以下網址：\n');
  console.log(authUrl);
  console.log('\n' + '─'.repeat(50));
  console.log('⏳ 等待授權回調...\n');

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (!req.url?.startsWith('/api/oauth2callback')) return;

      const queryObject = url.parse(req.url, true).query;
      const code = queryObject.code as string;

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h2>❌ 授權失敗，缺少授權碼</h2>');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <html><body style="font-family:sans-serif;text-align:center;padding:40px">
        <h2>✅ 授權成功！</h2>
        <p>請關閉此頁面，回到終端機查看結果。</p>
        </body></html>
      `);

      try {
        const { tokens } = await oauth2Client.getToken(code);
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
        console.log('✅ token.json 已儲存');
        console.log('\n現在可以啟動伺服器：npm start\n');
        server.close();
        resolve();
      } catch (error) {
        console.error('❌ 取得 token 失敗:', error);
        server.close();
        reject(error);
      }
    });

    server.listen(CALLBACK_PORT, () => {
      console.log(`🌐 本地伺服器已啟動（port ${CALLBACK_PORT}）`);
    });

    server.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${CALLBACK_PORT} 已被占用，請先關閉其他程式`);
      }
      reject(err);
    });
  });
}

getNewToken().catch((err) => {
  console.error('❌ 授權失敗:', err.message);
  process.exit(1);
});
