import { cp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sourceArgument = argument('source');
const licenseArgument = argument('license');
const output = resolve(argument('output') ?? join(here, 'dist'));

if (!sourceArgument || !licenseArgument) {
  console.error(
    'Usage: node sync-upstream.mjs --source /path/to/dist-web --license /path/to/LICENSE [--output /path/to/dist]',
  );
  process.exit(1);
}

const source = resolve(sourceArgument);
const license = resolve(licenseArgument);
const productCopyReplacements = [
  ['Not signed in · Sign in to Pi Code to start a conversation', 'No model configured · Configure a pi agent provider to start a conversation'],
  ['Sign in to your Pi account and set up a model to start chatting.', 'Configure a pi agent provider and model to start chatting.'],
  ['This Remote Control session requires authorization. Sign in with your Pi account to continue.', 'This Remote Control session requires an available pi agent provider.'],
  ['Title generation unavailable — needs a managed Pi Code login and at least one message', 'Title generation unavailable — needs a configured pi agent model and at least one message'],
  ['Sign in to Pi Code', 'Configure pi agent'],
  ['Sign in with Pi', 'Use pi agent configuration'],
  ['Sign in to Pi', 'Configure pi agent'],
  ['Pi membership benefits', 'your existing pi agent providers and models'],
  ['Pi membership', 'pi agent configuration'],
  ['Pi account', 'pi agent provider'],
  ['Pi model', 'pi agent model'],
  ['Pi User', 'pi agent'],
  ['Upgrade membership', 'Configure models'],
  ['Upgrade required', 'Model configuration required'],
  ['Upgrade your pi agent provider to use Pi Code', 'Configure a pi agent model to use Pi Code'],
  ['Your account is free. Upgrade to use a Pi model and start chatting.', 'Configure an available pi agent model to start chatting.'],
  ['Checking sign-in status…', 'Checking provider status…'],
  ['Sign-in polling failed repeatedly. Check the pi-code service and try again.', 'Provider status checks failed repeatedly. Check the pi-code service and try again.'],
  ['authBannerLogin:"Sign in"', 'authBannerLogin:"Configure"'],
  ['notSignedIn:"Not signed in"', 'notSignedIn:"Pi Agent"'],
  ['signIn:"Sign in"', 'signIn:"Configure"'],
  ['action:"Sign in"', 'action:"Configure"'],
  ['requiredTitle:"Sign in required"', 'requiredTitle:"Model configuration required"'],
  ['goToLogin:"Sign in"', 'goToLogin:"Configure"'],
  ['upgrade:"Upgrade"', 'upgrade:"Configure models"'],
  ['未登录 · 需要登录 Pi Code 才能开始对话', '尚未配置模型 · 请先配置 pi agent 模型服务'],
  ['无法生成标题：需要登录 Pi Code 托管账号，且会话中已有消息', '无法生成标题：需要配置 pi agent 模型，且会话中已有消息'],
  ['登录 Pi 账号并配置模型后，才能开始对话。', '配置 pi agent 模型服务后，才能开始对话。'],
  ['远程控制会话需要授权，登录 Pi 账号后即可继续。', '远程控制会话需要可用的 pi agent 模型服务。'],
  ['登录 Pi Code', '配置 pi agent'],
  ['已登录 Pi 账号', '已配置 pi agent'],
  ['登录 Pi 账号', '配置 pi agent 模型服务'],
  ['登录 Pi', '配置 pi agent'],
  ['Pi 会员权益', 'pi agent 原生配置'],
  ['Pi 账户', 'pi agent 模型服务'],
  ['Pi 账号', 'pi agent 模型服务'],
  ['Pi 模型', 'pi agent 模型'],
  ['Pi 用户', 'pi agent'],
  ['会员升级', '模型配置'],
  ['升级会员', '配置模型'],
  ['升级你的 pi agent 模型服务来使用 Pi Code', '请配置 pi agent 模型服务后使用 Pi Code'],
  ['当前为免费账户，配置模型后即可使用 pi agent 模型开始对话。', '请配置可用的 pi agent 模型后再开始对话。'],
  ['正在检查登录状态…', '正在检查模型服务状态…'],
  ['登录轮询连续失败，请检查 pi-code 服务后重试', '模型服务状态检查连续失败，请检查 pi-code 服务后重试'],
  ['使用 pi agent 模型服务登录后即可继续。', '配置可用的 pi agent 模型服务后即可继续。'],
  ['authBannerLogin:"登录"', 'authBannerLogin:"配置"'],
  ['notSignedIn:"未登录"', 'notSignedIn:"Pi Agent"'],
  ['permissionManual:"逐条确认"', 'permissionManual:"逐项确认"'],
  ['permissionYolo:"自动通过"', 'permissionYolo:"风险确认"'],
  ['permissionAuto:"完全自主"', 'permissionAuto:"无需确认"'],
  ['signIn:"登录"', 'signIn:"配置"'],
  ['action:"登录"', 'action:"配置"'],
  ['requiredTitle:"请先登录"', 'requiredTitle:"请先配置模型"'],
  ['goToLogin:"去登录"', 'goToLogin:"去配置"'],
  ['upgrade:"升级"', 'upgrade:"配置模型"'],
  ['kimi-code 进程', 'pi-code 服务'],
];

if (!(await isFile(join(source, 'index.html')))) {
  throw new Error(`Invalid WebUI distribution: ${source}`);
}
if (!(await isFile(license))) {
  throw new Error(`Upstream license not found: ${license}`);
}

await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });
await cp(license, join(here, 'LICENSE.upstream'));

for (const file of await walk(output)) {
  if (!file.endsWith('.html') && !file.endsWith('.js')) continue;
  const original = await readFile(file, 'utf8');
  let branded = original
    .replaceAll('KIMI_CODE_PASSWORD', 'PI_CODE_TOKEN')
    .replaceAll('Kimi Code Web', 'Pi Code')
    .replaceAll('Kimi Code', 'Pi Code')
    .replaceAll('Kimi Web', 'Pi Code')
    .replaceAll('Kimi', 'Pi');
  for (const [upstream, piCode] of productCopyReplacements) {
    branded = branded.replaceAll(upstream, piCode);
  }
  await writeFile(file, branded);
}

const indexPath = join(output, 'index.html');
const indexHtml = await readFile(indexPath, 'utf8');
const brandLink = '    <link rel="stylesheet" href="/pi-code-brand.css">';
const adapterScript = '    <script type="module" src="/model-config.js"></script>';
const headMarker = '  </head>';
const matches = indexHtml.split(headMarker).length - 1;
if (matches !== 1) throw new Error(`Expected exactly one </head> injection point, found ${matches}`);
const additions = [brandLink, adapterScript].filter((line) => !indexHtml.includes(line));
await writeFile(indexPath, indexHtml.replace(headMarker, `${additions.join('\n')}\n${headMarker}`));

await cp(join(here, 'adapter', 'pi-code-brand.css'), join(output, 'pi-code-brand.css'));
await cp(join(here, 'adapter', 'model-config', 'dist', 'model-config.js'), join(output, 'model-config.js'));
await cp(join(here, '..', 'webapp', 'public', 'favicon.ico'), join(output, 'favicon.ico'));

console.log(`Synced and branded ${basename(source)} into ${output}`);

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
