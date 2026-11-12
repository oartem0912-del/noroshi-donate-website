// Быстрая проверка синтаксиса всех JS-файлов (используется в CI).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const dirs = ['src', 'public/js', 'scripts', 'test'];
let bad = 0;
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of dirs.filter(fs.existsSync).flatMap(walk).filter((f) => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); } catch (e) { bad++; console.error(f + '\n' + e.stderr); }
}
if (bad) process.exit(1);
console.log('Синтаксис OK');
