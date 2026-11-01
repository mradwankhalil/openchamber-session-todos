// Frames load their stylesheet from their own folder; there is one source.
import { copyFileSync } from 'node:fs';

for (const dir of ['status', 'panel']) copyFileSync('shared/todos.css', `${dir}/todos.css`);
