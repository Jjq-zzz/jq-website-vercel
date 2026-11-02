import dotenv from 'dotenv';
import { createDatabase } from '../vercel/database.js';
dotenv.config({ path: '.env.local' });
dotenv.config();
const database = createDatabase();
try { await database.migrate(); console.log('Vercel 云端数据库结构初始化完成。'); }
finally { database.client.close(); }
