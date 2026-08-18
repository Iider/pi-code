import { copyFile, mkdir } from 'node:fs/promises';

const files = ['model-config.js'];
const outputs = [new URL('./dist/', import.meta.url), new URL('../../dist/', import.meta.url)];

await Promise.all(outputs.map((output) => mkdir(output, { recursive: true })));
await Promise.all(outputs.flatMap((output) => files.map((file) => (
  copyFile(new URL(`./src/${file}`, import.meta.url), new URL(file, output))
))));
await copyFile(
  new URL('../pi-code-brand.css', import.meta.url),
  new URL('../../dist/pi-code-brand.css', import.meta.url),
);
