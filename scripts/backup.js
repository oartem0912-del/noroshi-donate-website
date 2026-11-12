// Ручной запуск: npm run backup
import { openDb, closeDb } from '../src/db.js';
import { makeBackup } from '../src/backup.js';
openDb();
console.log('Создана копия:', makeBackup());
closeDb();
