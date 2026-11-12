// Проверка восстановления: npm run backup:verify [путь к файлу]  (по умолчанию — последняя копия)
import { verifyBackup, latestBackup } from '../src/backup.js';
const file = process.argv[2] || latestBackup();
if (!file) { console.error('Резервных копий нет'); process.exit(1); }
const r = verifyBackup(file);
console.log(file, r);
process.exit(r.ok ? 0 : 1);
