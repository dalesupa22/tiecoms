import { pool } from './db.ts';
import { migrate } from './migrate.ts';

migrate().then(() => pool.end()).catch((e) => { console.error(e); process.exit(1); });
