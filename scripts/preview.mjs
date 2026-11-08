/**
 * 本地预览面板 —— 不需要装 DSH，也不用连真实书签。
 *
 *   node scripts/preview.mjs              # 起服务并自动打开浏览器
 *   node scripts/preview.mjs --port 6300  # 换端口
 *   node scripts/preview.mjs --no-open    # 只起服务，不打开浏览器
 *
 * 数据来自 examples/demo-bookmarks.json（全部是虚构收藏，可以随手改）。
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __testing } from '../index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PANEL_DIR = join(ROOT, 'panel')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  const next = at >= 0 ? argv[at + 1] : ''
  return next && !next.startsWith('--') ? next : fallback
}

const PORT = Number(value('port', 62605)) || 62605

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

/* ---------------- 用示例数据拼一份宿主 payload ---------------- */

const demo = JSON.parse(await readFile(join(ROOT, 'examples', 'demo-bookmarks.json'), 'utf8'))
const categories = demo.categories.map((cat, index) => ({
  id: cat.id,
  name: cat.name,
  color: cat.color || '#8a8f98',
  order: index,
  parentId: '',
}))
const rawItems = demo.bookmarks.map((bookmark, index) => ({
  url: bookmark.url,
  title: bookmark.title,
  folder: bookmark.folder || '',
  added: Date.now() - index * 3600_000,
}))
const sources = [{
  id: 'chrome:Default',
  browser: 'Chrome',
  profile: 'Default',
  label: 'Chrome',
  file: 'Bookmarks',
  path: '(demo)',
  mtime: Date.now(),
  count: rawItems.length,
  items: rawItems,
}]
const overrides = { items: {}, categories, renames: {}, folderMap: {}, rev: 1 }
for (const bookmark of demo.bookmarks) {
  const category = categories.find((cat) => cat.name === bookmark.category)
  if (category) overrides.items[bookmark.url] = { categoryId: category.id }
}
const built = __testing.buildItems(sources, overrides, {})
const counts = new Map()
for (const item of built) counts.set(item.categoryId, (counts.get(item.categoryId) || 0) + 1)

const payload = {
  items: built,
  categoryDefs: categories.map((cat) => ({ ...cat, custom: true, hint: '', count: counts.get(cat.id) || 0 })),
  manual: true,
  folderMap: {},
  sources: [{ id: 'chrome:Default', label: 'Chrome', browser: 'Chrome', profile: 'Default', count: built.length, mtime: Date.now() }],
  stats: { total: built.length },
  builtAt: Date.now(),
}

const wrapper = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>星河书签 · 预览</title>
<style>html,body{margin:0;height:100%;background:#050508}iframe{width:100%;height:100%;border:0;display:block}</style>
</head><body>
<iframe id="panel" src="/panel/index.html"></iframe>
<script>
  const PAYLOAD = ${JSON.stringify(payload)};
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== 'bookmarks-desk' || data.type !== 'ready') return;
    document.getElementById('panel').contentWindow.postMessage({ source: 'dsh-host', type: 'data', payload: PAYLOAD }, '*');
  });
</script>
</body></html>`

/* ---------------- 服务 ---------------- */

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const send = (status, body, type = 'text/plain; charset=utf-8') => {
    res.statusCode = status
    res.setHeader('content-type', type)
    res.end(body)
  }

  if (url.pathname === '/' || url.pathname === '/index.html') return send(200, wrapper, TYPES['.html'])

  if (url.pathname.startsWith('/panel/')) {
    const name = normalize(url.pathname.slice('/panel/'.length)).replace(/^([/\\])+/, '')
    if (name.includes('..')) return send(403, 'forbidden')
    try {
      const body = await readFile(join(PANEL_DIR, name))
      const ext = name.slice(name.lastIndexOf('.'))
      return send(200, body, TYPES[ext] || 'application/octet-stream')
    } catch {
      return send(404, 'not found')
    }
  }

  return send(404, 'not found')
})

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/`
  console.log(`星河书签预览：${url}`)
  console.log(`示例数据：${demo.bookmarks.length} 条收藏 / ${categories.length} 个分类（examples/demo-bookmarks.json）`)
  console.log('Ctrl+C 结束。')
  if (flag('no-open')) return
  const [command, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]]
  execFile(command, args, () => {})
})
