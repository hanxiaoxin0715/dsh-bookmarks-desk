/**
 * bookmarks-desk — Host 半面。
 *
 * 读本机 Chromium 系浏览器的收藏夹（Chrome 登录态下书签在 AccountBookmarks），
 * 做三件事：① 用固定分类法归类 ② 每条生成一句人话简介（走当前默认模型）
 * ③ 接受用户对本地的分类/简介的修改，全部只写本机 overrides，不改浏览器。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PREFIX = '/bookmarks-desk'
const PANEL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'panel')
const PANEL_TYPES = {
  'index.html': 'text/html; charset=utf-8',
  'tailwind.js': 'text/javascript; charset=utf-8',
  'lucide.js': 'text/javascript; charset=utf-8',
}
const DATA_DIR = join(homedir(), '.dsh', 'bookmarks-desk')
const OVERRIDES_FILE = join(DATA_DIR, 'overrides.json')
const ENRICH_FILE = join(DATA_DIR, 'enrich.json')
const CACHE_MS = 4000

/**
 * 浏览器用户目录：三个平台各自的默认位置。
 * win 用 %LOCALAPPDATA%，mac 用 ~/Library/Application Support，linux 用 $XDG_CONFIG_HOME。
 */
const PLATFORM = process.platform
const HOME = homedir()

function userDataRoot(winParts, macParts, linuxParts) {
  if (PLATFORM === 'win32') {
    const base = process.env.LOCALAPPDATA || join(HOME, 'AppData', 'Local')
    return join(base, ...winParts)
  }
  if (PLATFORM === 'darwin') return join(HOME, 'Library', 'Application Support', ...macParts)
  const base = process.env.XDG_CONFIG_HOME || join(HOME, '.config')
  return join(base, ...linuxParts)
}

const BROWSERS = [
  {
    id: 'chrome',
    label: 'Chrome',
    root: userDataRoot(['Google', 'Chrome', 'User Data'], ['Google', 'Chrome'], ['google-chrome']),
  },
  {
    id: 'chrome-beta',
    label: 'Chrome Beta',
    root: userDataRoot(['Google', 'Chrome Beta', 'User Data'], ['Google', 'Chrome Beta'], ['google-chrome-beta']),
  },
  {
    id: 'edge',
    label: 'Edge',
    root: userDataRoot(['Microsoft', 'Edge', 'User Data'], ['Microsoft Edge'], ['microsoft-edge']),
  },
  {
    id: 'brave',
    label: 'Brave',
    root: userDataRoot(
      ['BraveSoftware', 'Brave-Browser', 'User Data'],
      ['BraveSoftware', 'Brave-Browser'],
      ['BraveSoftware', 'Brave-Browser'],
    ),
  },
  {
    id: 'chromium',
    label: 'Chromium',
    root: userDataRoot(['Chromium', 'User Data'], ['Chromium'], ['chromium']),
  },
]

/**
 * 数据来源：默认只读 Chrome（主力浏览器）。
 * 想同时合并 Edge，把环境变量 BOOKMARKS_DESK_BROWSERS 设为 "chrome,edge" 即可。
 * 若 Chrome 里一条都读不到，会自动回退到其它浏览器，避免面板空着。
 */
const SOURCE_IDS = (process.env.BOOKMARKS_DESK_BROWSERS || 'chrome')
  .split(',')
  .map((id) => id.trim().toLowerCase())
  .filter(Boolean)

const PROFILE_RE = /^(Default|Profile \d+|Guest Profile|System Profile)$/
const ROOT_LABEL = { bookmark_bar: '书签栏', other: '其他书签', synced: '移动设备书签' }

/** 分类法是固定的：模型只能从这里选，用户也可以改成这些或自建的分类。 */
const BASE_CATEGORIES = [
  { id: 'dev', name: '开发与代码', hint: 'GitHub/Gitee 仓库、开源项目、API 与 SDK 文档、开发者工具' },
  { id: 'ai', name: 'AI 与模型', hint: 'AI 产品与模型、算力与 API 账号、ComfyUI/绘画、AI 教程' },
  { id: 'media', name: '影视与音视频', hint: '电影网与影视站、B 站/YouTube、动漫、音乐、直播' },
  { id: 'infra', name: '服务器与网络', hint: 'VPS 与云服务器、NAS、域名与 CDN、代理/节点、内网设备' },
  { id: 'assets', name: '资源与素材', hint: '资源站、字体图片、3D 模型、模板、网盘分享' },
  { id: 'learn', name: '教程与文档', hint: '教程课程、官方文档、学习资料、wiki' },
  { id: 'soft', name: '软件与工具', hint: '软件下载、破解激活、Mac/Windows 工具、浏览器插件' },
  { id: 'biz', name: '电商与生意', hint: 'OZON/闲鱼/跨境、选品、支付与收款' },
  { id: 'life', name: '生活与其他', hint: '购物、生活服务、暂时判断不了的杂项' },
]

const RULES = {
  dev: [/github\.com|gitlab\.com|gitee\.com|stackoverflow|npmjs\.com|crates\.io|pypi\.org/i, /开源|仓库|源码|repo\b|sdk|api 文档|开发者/i],
  ai: [/openai|claude|anthropic|huggingface|modelscope|comfyui|midjourney|chatgpt|gemini|deepseek/i, /\bai\b|模型|算力|token|推理|大模型|智能体|agent/i],
  media: [/bilibili\.com|youtube\.com|youtu\.be|douyin|iqiyi|youku|v\.qq\.com|mgtv|netflix|spotify/i, /电影|影视|动漫|番剧|音乐|直播|mv|剧集/i],
  infra: [/cloudflare|vultr|digitalocean|aliyun|tencentcloud|bandwagon|vps|nas|192\.168\.|127\.0\.0\.1/i, /服务器|域名|节点|代理|机场|内网|cdn|端口|宝塔|docker/i],
  assets: [/pan\.(quark|baidu)|aliyundrive|123pan|lanraragi/i, /资源|素材|字体|模型|模板|贴图|预设|素材库/i],
  learn: [/docs\.|wiki|notion|yuque|juejin|segmentfault/i, /教程|课程|文档|学习|入门|指南|手册/i],
  soft: [/soft|download|patch|portable/i, /软件|下载|破解|激活|绿色版|工具|插件|扩展/i],
  biz: [/ozon|1688|taobao|jd\.com|pinduoduo|alipay/i, /电商|跨境|选品|店铺|支付|收款|订单/i],
}

const DATE_SEGMENTS = [
  /^(19|20)\d{2}$/,
  /^(19|20)\d{2}\s*年$/,
  /^(19|20)\d{2}\s*[\/.\-]\s*\d{1,2}$/,
  /^(19|20)\d{2}\s*[（(]?\s*\d{1,2}\s*月(\s*[-–—~至]\s*\d{1,2}\s*月)?\s*[）)]?$/,
]

function isDateSegment(segment) {
  const text = String(segment || '').trim()
  return DATE_SEGMENTS.some((re) => re.test(text))
}

function chromeTime(value) {
  const n = Number(value)
  if (!n || !isFinite(n)) return 0
  return Math.round((n / 1000) + Date.UTC(1601, 0, 1))
}

function walkNode(node, path, out) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'url' && typeof node.url === 'string') {
    out.push({
      title: String(node.name || '').trim(),
      url: node.url,
      folder: path.join(' / '),
      depth: path.length,
      added: chromeTime(node.date_added),
    })
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const isFolder = child && child.type === 'folder'
      const name = String((child && child.name) || '').trim()
      walkNode(child, isFolder && name ? [...path, name] : path, out)
    }
  }
}

async function readBookmarkFile(file) {
  const text = await readFile(file, 'utf8')
  const json = JSON.parse(text)
  const items = []
  for (const [key, root] of Object.entries(json.roots || {})) walkNode(root, [ROOT_LABEL[key] || key], items)
  return items
}

async function fileInfo(file) {
  try {
    const info = await stat(file)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

async function readProfile(profileDir) {
  let best = null
  for (const name of ['AccountBookmarks', 'Bookmarks']) {
    const file = join(profileDir, name)
    const info = await fileInfo(file)
    if (!info) continue
    let items = []
    try {
      items = await readBookmarkFile(file)
    } catch {
      continue
    }
    if (!best || items.length > best.items.length) best = { file: name, filePath: file, info, items }
  }
  return best
}

async function collectSources(list) {
  const sources = []
  for (const browser of list) {
    let entries = []
    try {
      entries = await readdir(browser.root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !PROFILE_RE.test(entry.name)) continue
      const found = await readProfile(join(browser.root, entry.name))
      if (!found) continue
      sources.push({
        id: `${browser.id}:${entry.name}`,
        browser: browser.label,
        profile: entry.name,
        label: entry.name === 'Default' ? browser.label : `${browser.label} · ${entry.name}`,
        file: found.file,
        path: found.filePath,
        mtime: Math.round(found.info.mtimeMs),
        count: found.items.length,
        items: found.items,
      })
    }
  }
  return sources
}

async function detectSources() {
  const wanted = BROWSERS.filter((b) => SOURCE_IDS.includes(b.id))
  const primary = wanted.length ? wanted : BROWSERS
  const picked = await collectSources(primary)
  if (picked.length) return picked
  // 主力浏览器里读不到任何东西时，回退到其余浏览器
  const rest = BROWSERS.filter((b) => !primary.includes(b))
  return rest.length ? collectSources(rest) : []
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** 有些书签的名字是纯零宽字符，去掉后为空就退回域名。 */
function cleanTitle(title, url) {
  const text = String(title || '').replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '').trim()
  return text || hostOf(url) || String(url || '')
}

/* ---------------- 本地存储：简介缓存 + 用户改动 ---------------- */

let enrichCache = null
let overridesCache = null

async function loadJson(file, fallback) {
  try {
    const text = await readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

async function saveJson(file, value) {
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(file, JSON.stringify(value, null, 0), 'utf8')
}

async function loadEnrich() {
  if (!enrichCache) {
    const raw = await loadJson(ENRICH_FILE, {})
    enrichCache = raw && typeof raw === 'object' ? raw : {}
  }
  return enrichCache
}

const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g

/** 分类名清洗：去掉零宽字符、全角空格，压掉多余空白 */
function cleanName(value, max = 20) {
  return String(value == null ? '' : value)
    .replace(ZERO_WIDTH_RE, '')
    .replace(/\u00A0|\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

async function loadOverrides() {
  if (!overridesCache) {
    const raw = await loadJson(OVERRIDES_FILE, {})
    const categories = (Array.isArray(raw.categories) ? raw.categories : []).map((cat) => {
      const name = cleanName(cat.name)
      return name ? { ...cat, name } : cat
    })
    overridesCache = {
      items: raw.items && typeof raw.items === 'object' ? raw.items : {},
      categories,
      renames: raw.renames && typeof raw.renames === 'object' ? raw.renames : {},
      folderMap: raw.folderMap && typeof raw.folderMap === 'object' ? raw.folderMap : {},
      rev: Number(raw.rev) || 0,
    }
  }
  return overridesCache
}

/** 每次改动 overrides 都自增 rev，让 /state 的缓存签名失效。 */
async function saveOverrides(overrides) {
  overrides.rev = (Number(overrides.rev) || 0) + 1
  overridesCache = overrides
  await saveJson(OVERRIDES_FILE, overrides)
  return overrides
}

const CATEGORY_PALETTE = [
  '#9b8afb', '#6fbf9b', '#d8a657', '#6c9bd1', '#c98a9b',
  '#69b8b3', '#b08bd6', '#d08a5a', '#8a8f98', '#7f9c6a',
]

/* ---------------- 分类 ---------------- */

function allCategories(overrides) {
  const base = BASE_CATEGORIES.map((c) => ({ ...c, name: overrides.renames[c.id] || c.name, custom: false, parentId: '' }))
  const custom = overrides.categories.map((c, index) => ({
    id: c.id,
    name: c.name,
    hint: c.hint || '自定义分类',
    color: c.color || CATEGORY_PALETTE[index % CATEGORY_PALETTE.length],
    order: Number.isFinite(Number(c.order)) ? Number(c.order) : index,
    parentId: c.parentId || '',
    custom: true,
  }))
  return [...base, ...custom]
}

/** 某个分类的整棵子树 id（含自己） */
function categorySubtree(overrides, id) {
  const ids = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const c of overrides.categories) {
      if (c.parentId && ids.has(c.parentId) && !ids.has(c.id)) {
        ids.add(c.id)
        grew = true
      }
    }
  }
  return ids
}

/** 文件夹路径的祖先链，从最具体到最宽泛：a/b/c → a/b/c, a/b, a */
function folderCandidates(folder) {
  const parts = String(folder || '').split(' / ').map((p) => p.trim()).filter(Boolean)
  const out = []
  for (let i = parts.length; i > 0; i -= 1) out.push(parts.slice(0, i).join(' / '))
  return out
}

/** 文件夹 → 分类 的映射，支持继承父文件夹。 */
function mappedCategory(folder, folderMap) {
  if (!folderMap) return ''
  for (const key of folderCandidates(folder)) {
    const value = folderMap[key]
    if (value) return String(value)
  }
  return ''
}

/** 规则兜底：模型没跑过的条目也要有个去处。 */
function ruleCategory(item) {
  const haystack = `${item.title} ${item.url} ${item.folder}`
  let bestId = 'life'
  let bestScore = 0
  for (const [id, patterns] of Object.entries(RULES)) {
    let score = 0
    for (const re of patterns) if (re.test(haystack)) score += re.source.indexOf('|') >= 0 ? 2 : 3
    if (score > bestScore) { bestScore = score; bestId = id }
  }
  return bestId
}

/* ---------------- 模型 ---------------- */

function modelInfo(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    if (!ctx.get('llm') || !selection?.provider || !selection?.model) return null
    return { provider: selection.provider, model: selection.model }
  } catch {
    return null
  }
}

function extractJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1] : text
  const start = body.search(/[[{]/)
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'))
  if (start < 0 || end < start) throw new Error('模型没有返回 JSON')
  return JSON.parse(body.slice(start, end + 1))
}

async function callModel(ctx, { system, user, maxTokens }) {
  const info = modelInfo(ctx)
  if (!info) throw new Error('当前没有可用模型')
  const llm = ctx.get('llm')
  const call = await llm.prepareCall({ provider: info.provider, model: info.model, maxTokens }, undefined, (controls, resolved) => {
    const effort = resolved && resolved.reasoning && resolved.reasoning.efforts && resolved.reasoning.efforts[0]
    return effort && effort.id ? { ...controls, reasoningEffort: effort.id } : controls
  })
  let text = ''
  let finish = null
  for await (const chunk of call.stream({
    ...call.config,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }], source: { kind: 'bookmarks-desk' } }],
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') {
      finish = chunk.reason
      if (chunk.reason && ['error', 'aborted'].includes(chunk.reason.kind)) {
        throw new Error((chunk.reason.failure && chunk.reason.failure.message) || '模型调用失败')
      }
    }
  }
  return { text, finish }
}

const SYSTEM_PROMPT = [
  '你在整理一个人的浏览器收藏夹。给定若干条收藏（序号、标题、网址、所在文件夹）和一份固定分类表，',
  '为每一条选出最合适的分类 id，并写一句 18~40 字的中文说明：这条是什么、大概用来干什么。',
  '说明要具体，别复述标题；网址看不出用途时按标题和文件夹判断，实在判断不了就归 life。',
  '输出必须是 JSONL：每行一个 JSON 对象，形如 {"n":1,"c":"dev","s":"……"}，',
  '不要数组、不要 Markdown 代码块、不要任何解释文字，也不要漏行。',
].join('')

/** 逐行解析 JSONL；坏行只丢那一行，再退回整体 JSON。 */
function parseRows(text) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    let trimmed = line.trim()
    if (!trimmed) continue
    trimmed = trimmed.replace(/^```(?:json|jsonl)?/i, '').replace(/```$/, '').trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') rows.push(obj)
    } catch {
      /* 这一行坏了就跳过，不影响别的行 */
    }
  }
  if (rows.length) return rows
  try {
    const parsed = extractJson(text)
    const list = Array.isArray(parsed) ? parsed : (parsed && parsed.items)
    if (Array.isArray(list)) return list
  } catch {
    /* 落到下面返回空 */
  }
  return []
}

function rowIndex(row) {
  const raw = row && (row.n !== undefined ? row.n : row.i)
  const value = Number(raw)
  return isFinite(value) ? value : 0
}

/* ---------------- 索引 ---------------- */

function urlKey(url) {
  return String(url || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function buildItems(sources, overrides, enrich) {
  const items = []
  const seenGlobal = new Set()
  /** 用户只要建过分类，就进入「我的分类」模式：AI 结果不再决定归类，只保留简介。 */
  const manual = overrides.categories.length > 0
  for (const source of sources) {
    for (const raw of source.items) {
      if (!raw.url || /^javascript:/i.test(raw.url)) continue
      const key = urlKey(raw.url)
      if (!key || seenGlobal.has(key)) continue
      seenGlobal.add(key)
      const override = overrides.items[raw.url] || overrides.items[key] || null
      const learned = enrich[raw.url] || null
      const ruleId = ruleCategory(raw)
      const folderId = manual ? mappedCategory(raw.folder, overrides.folderMap) : ''
      const categoryId = (override && override.categoryId)
        || folderId
        || (manual ? 'unassigned' : ((learned && learned.categoryId) || ruleId))
      const categorySource = override && override.categoryId
        ? 'user'
        : folderId
          ? 'folder'
          : manual
            ? 'none'
            : learned && learned.categoryId ? 'ai' : 'rule'
      items.push({
        id: `${source.id}|${raw.url}`,
        title: (override && override.title) || cleanTitle(raw.title, raw.url),
        url: raw.url,
        host: hostOf(raw.url),
        folder: raw.folder,
        added: raw.added,
        source: source.id,
        sourceLabel: source.label,
        ruleCategory: ruleId,
        categoryId,
        categorySource,
        summary: (override && override.summary) || (learned && learned.summary) || '',
        tags: Array.isArray(override && override.tags) ? override.tags : [],
        edited: Boolean(override && (override.title || override.summary || override.categoryId || (override.tags && override.tags.length))),
        enriched: Boolean(learned && learned.summary) || Boolean(override && override.summary),
      })
    }
  }
  items.sort((a, b) => (b.added || 0) - (a.added || 0))
  return items
}

let cache = { at: 0, signature: '', payload: null }

async function loadIndex({ force = false } = {}) {
  const [sources, overrides, enrich] = await Promise.all([detectSources(), loadOverrides(), loadEnrich()])
  const signature = sources.map((s) => `${s.id}:${s.mtime}:${s.count}`).join('|')
  const overrideStamp = Object.keys(overrides.items).length
  const enrichStamp = Object.keys(enrich).length
  const full = `${signature}|${overrideStamp}|${enrichStamp}|${overrides.rev || 0}|${overrides.categories.length}|${Object.keys(overrides.folderMap || {}).length}`
  if (!force && cache.payload && cache.signature === full && Date.now() - cache.at < CACHE_MS) return cache.payload

  const items = buildItems(sources, overrides, enrich)
  const manual = overrides.categories.length > 0
  const counts = new Map()
  for (const item of items) counts.set(item.categoryId, (counts.get(item.categoryId) || 0) + 1)
  const categories = allCategories(overrides)
    .filter((c) => (manual ? c.custom : true))
    .map((c) => ({ ...c, count: counts.get(c.id) || 0 }))
    .filter((c) => c.count > 0 || c.custom)
    .sort(manual
      ? (a, b) => (a.order - b.order) || a.name.localeCompare(b.name, 'zh')
      : (a, b) => b.count - a.count)
  const enriched = items.filter((i) => i.enriched).length

  const payload = {
    builtAt: Date.now(),
    sources: sources.map((s) => ({ id: s.id, label: s.label, browser: s.browser, profile: s.profile, file: s.file, path: s.path, count: s.count, mtime: s.mtime })),
    stats: { total: items.length },
    progress: { total: items.length, enriched, pending: items.length - enriched },
    manual,
    categories,
    folderMap: overrides.folderMap || {},
    unclassified: counts.get('unassigned') || counts.get('none') || 0,
    items,
  }
  cache = { at: Date.now(), signature: full, payload }
  return payload
}

/* ---------------- 路由 ---------------- */

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function sendText(res, status, text) {
  res.statusCode = status
  res.setHeader('content-type', 'text/plain; charset=utf-8')
  res.end(text)
}

async function readBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 })
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 })
  }
}

function guard(ctx, req) {
  const connection = ctx.get('connection')
  if (!connection || typeof connection.requestRejection !== 'function') return 403
  return connection.requestRejection({ headers: req.headers })
}

function openExternal(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw Object.assign(new Error('bad url'), { status: 400 })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw Object.assign(new Error('unsupported scheme'), { status: 400 })
  const [command, args] = PLATFORM === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href]]
    : PLATFORM === 'darwin'
      ? ['open', [parsed.href]]
      : ['xdg-open', [parsed.href]]
  execFile(command, args, () => {})
}

/** 供本地脚本做数据源自检（不影响插件加载）。 */
export const __testing = {
  detectSources, buildItems, loadIndex, urlKey, SOURCE_IDS, BROWSERS,
  allCategories, mappedCategory, folderCandidates, loadOverrides, CATEGORY_PALETTE, categorySubtree,
  cleanName,
}

export default {
  name: 'bookmarks-desk',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    mkdir(DATA_DIR, { recursive: true }).catch(() => {})

    async function classifyBatch(size, sourceId) {
      const overrides = await loadOverrides()
      const enrich = await loadEnrich()
      const payload = await loadIndex({ force: true })
      const pending = payload.items
        .filter((item) => !overrides.items[item.url] && !enrich[item.url])
        .filter((item) => !sourceId || item.source === sourceId)
        .slice(0, size)
      if (!pending.length) return { added: 0, remaining: 0 }

      const catalog = allCategories(overrides).map((c) => `${c.id} = ${c.name}（${c.hint}）`).join('\n')
      const list = pending.map((item, index) => ({ n: index + 1, t: item.title.slice(0, 90), u: item.url.slice(0, 160), f: item.folder.slice(0, 80) }))
      const user = `分类表：\n${catalog}\n\n待整理条目（JSON）：\n${JSON.stringify(list)}`

      const text = await callModel(ctx, { system: SYSTEM_PROMPT, user, maxTokens: 4000 })
      const rows = parseRows(text.text)
      if (!rows.length) {
        const hint = text.finish && text.finish.kind ? `（finish=${text.finish.kind}）` : ''
        throw new Error(`模型输出无法解析${hint}：${String(text.text || '').slice(0, 120).replace(/\s+/g, ' ')}`)
      }
      const validIds = new Set(allCategories(overrides).map((c) => c.id))
      let added = 0
      for (const row of rows) {
        const index = rowIndex(row) - 1
        const item = pending[index]
        if (!item) continue
        const categoryId = validIds.has(row.c) ? row.c : item.ruleCategory
        const summary = String(row.s || '').trim().slice(0, 120)
        if (!summary) continue
        enrich[item.url] = { categoryId, summary, at: Date.now() }
        added++
      }
      enrichCache = enrich
      await saveJson(ENRICH_FILE, enrich)
      const remaining = payload.items
        .filter((item) => !overrides.items[item.url] && !enrich[item.url])
        .filter((item) => !sourceId || item.source === sourceId)
        .length
      return { added, remaining }
    }

    /** 后台批量任务：跑在 Host，关掉面板也不会中断。 */
    const job = { running: false, done: 0, total: 0, error: null, sourceId: null, stop: false, startedAt: 0 }

    async function runJob() {
      if (job.running) return
      job.running = true
      job.stop = false
      job.error = null
      job.done = 0
      job.startedAt = Date.now()
      try {
        let failures = 0
        for (;;) {
          if (job.stop) break
          const snapshot = await loadIndex({ force: true })
          const pending = snapshot.items.filter((item) => !item.enriched && (!job.sourceId || item.source === job.sourceId))
          job.total = job.done + pending.length
          if (!pending.length) break
          try {
            const result = await classifyBatch(20, job.sourceId)
            job.done += result.added || 0
            job.total = job.done + (result.remaining || 0)
            failures = 0
            if (!result.added) break
          } catch (error) {
            failures++
            job.error = String((error && error.message) || error)
            if (failures >= 3) break
            await new Promise((resolve) => setTimeout(resolve, 1200))
          }
        }
      } catch (error) {
        job.error = String((error && error.message) || error)
      } finally {
        job.running = false
      }
    }

    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost')
        const route = url.pathname.slice(PREFIX.length) || '/'

        // 面板版本（index.html 的 mtime）：面板自己轮询它，文件更新后自动重载
        if (req.method === 'GET' && route === '/panel/version') {
          try {
            const info = await stat(join(PANEL_DIR, 'index.html'))
            return sendJson(res, 200, { at: Math.round(info.mtimeMs), size: info.size })
          } catch {
            return sendJson(res, 200, { at: 0, size: 0 })
          }
        }

        // 面板是纯静态外壳（不含任何数据），数据一律走 postMessage 注入，所以不设鉴权
        if (req.method === 'GET' && (route === '/panel' || route === '/panel/' || route.indexOf('/panel/') === 0)) {
          const name = route === '/panel' || route === '/panel/' ? 'index.html' : route.slice('/panel/'.length)
          const type = PANEL_TYPES[name]
          if (!type) return sendText(res, 404, 'not found')
          try {
            const body = await readFile(join(PANEL_DIR, name))
            res.statusCode = 200
            res.setHeader('content-type', type)
            res.setHeader('cache-control', 'no-store')
            res.end(body)
          } catch {
            sendText(res, 404, 'panel not built')
          }
          return
        }

        const rejection = guard(ctx, req)
        if (rejection) return sendJson(res, rejection, { error: 'unauthorized' })

        try {
          if (req.method === 'GET' && (route === '/state' || route === '/')) {
            const force = url.searchParams.get('refresh') === '1'
            const payload = await loadIndex({ force })
            return sendJson(res, 200, {
              ...payload,
              classify: { running: job.running, done: job.done, total: job.total, error: job.error, startedAt: job.startedAt },
            })
          }

          if (req.method === 'POST' && route === '/classify/start') {
            const body = await readBody(req)
            const sourceId = typeof body.source === 'string' && body.source ? body.source : null
            if (!job.running) {
              job.sourceId = sourceId
              runJob()
            }
            return sendJson(res, 200, { ok: true, running: true })
          }

          if (req.method === 'POST' && route === '/classify/stop') {
            job.stop = true
            return sendJson(res, 200, { ok: true })
          }

          if (req.method === 'GET' && route === '/classify/status') {
            return sendJson(res, 200, { running: job.running, done: job.done, total: job.total, error: job.error })
          }

          if (req.method === 'POST' && route === '/classify') {
            const body = await readBody(req)
            const size = Math.min(40, Math.max(5, Number(body.size) || 12))
            const sourceId = typeof body.source === 'string' && body.source ? body.source : null
            try {
              const result = await classifyBatch(size, sourceId)
              return sendJson(res, 200, { ok: true, ...result })
            } catch (error) {
              return sendJson(res, 200, { ok: false, error: error.message || 'classify failed' })
            }
          }

          if (req.method === 'POST' && route === '/override') {
            const body = await readBody(req)
            const overrides = await loadOverrides()
            const target = String(body.url || '')
            if (!target) return sendJson(res, 400, { error: 'url required' })
            const next = { ...(overrides.items[target] || {}) }
            if (body.categoryId !== undefined) {
              if (body.categoryId === 'auto') delete next.categoryId
              else next.categoryId = String(body.categoryId)
            }
            if (body.summary !== undefined) next.summary = String(body.summary).trim()
            if (body.title !== undefined) next.title = String(body.title).trim().slice(0, 200)
            if (Array.isArray(body.tags)) {
              next.tags = body.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 12)
            }
            if (Object.keys(next).length) overrides.items[target] = next
            else delete overrides.items[target]
            await saveOverrides(overrides)
            return sendJson(res, 200, { ok: true })
          }

          if (req.method === 'POST' && route === '/category/add') {
            const body = await readBody(req)
            const name = cleanName(body.name)
            if (!name) return sendJson(res, 400, { error: 'name required' })
            const overrides = await loadOverrides()
            const parentId = String(body.parentId || '')
            if (parentId && !overrides.categories.some((c) => c.id === parentId)) {
              return sendJson(res, 400, { error: 'unknown parent' })
            }
            const id = `custom-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
            const siblings = overrides.categories.filter((c) => (c.parentId || '') === parentId)
            const order = siblings.reduce((max, c) => Math.max(max, Number(c.order) || 0), -1) + 1
            const color = String(body.color || CATEGORY_PALETTE[overrides.categories.length % CATEGORY_PALETTE.length])
            overrides.categories.push({ id, name, color, order, parentId })
            await saveOverrides(overrides)
            return sendJson(res, 200, { ok: true, id, name, color, order, parentId })
          }

          if (req.method === 'POST' && route === '/category/update') {
            const body = await readBody(req)
            const overrides = await loadOverrides()
            const id = String(body.id || '')
            const category = overrides.categories.find((c) => c.id === id)
            if (!category) return sendJson(res, 400, { error: 'unknown category' })
            if (body.name !== undefined) {
              const name = cleanName(body.name)
              if (!name) return sendJson(res, 400, { error: 'name required' })
              category.name = name
            }
            if (body.color !== undefined) category.color = String(body.color || '').slice(0, 24)
            if (body.order !== undefined && Number.isFinite(Number(body.order))) category.order = Number(body.order)
            if (body.parentId !== undefined) {
              const parentId = String(body.parentId || '')
              if (parentId) {
                if (parentId === id) return sendJson(res, 400, { error: 'cannot nest into itself' })
                if (!overrides.categories.some((c) => c.id === parentId)) return sendJson(res, 400, { error: 'unknown parent' })
                if (categorySubtree(overrides, id).has(parentId)) return sendJson(res, 400, { error: 'cannot nest into descendant' })
              }
              category.parentId = parentId
              const siblings = overrides.categories.filter((c) => c.id !== id && (c.parentId || '') === parentId)
              category.order = siblings.reduce((max, c) => Math.max(max, Number(c.order) || 0), -1) + 1
            }
            await saveOverrides(overrides)
            return sendJson(res, 200, { ok: true })
          }

          if (req.method === 'POST' && route === '/category/reorder') {
            const body = await readBody(req)
            const overrides = await loadOverrides()
            const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
            ids.forEach((id, index) => {
              const category = overrides.categories.find((c) => c.id === id)
              if (category) category.order = index
            })
            await saveOverrides(overrides)
            return sendJson(res, 200, { ok: true })
          }

          if (req.method === 'POST' && route === '/category/rename') {
            const body = await readBody(req)
            const overrides = await loadOverrides()
            const id = String(body.id || '')
            const name = String(body.name || '').trim().slice(0, 20)
            if (!id || !name) return sendJson(res, 400, { error: 'bad request' })
            const base = BASE_CATEGORIES.find((c) => c.id === id)
            if (base) overrides.renames[id] = name
            else {
              const category = overrides.categories.find((c) => c.id === id)
              if (!category) return sendJson(res, 400, { error: 'unknown category' })
              category.name = name
            }
            await saveOverrides(overrides)
            return sendJson(res, 200, { ok: true })
          }

          if (req.method === 'POST' && route === '/category/remove') {
            const body = await readBody(req)
            const overrides = await loadOverrides()
            const id = String(body.id || '')
            if (!overrides.categories.some((c) => c.id === id)) return sendJson(res, 400, { error: 'unknown category' })
            const doomed = categorySubtree(overrides, id)
            overrides.categories = overrides.categories.filter((c) => !doomed.has(c.id))
            for (const [key, value] of Object.entries(overrides.items)) {
              if (value && doomed.has(value.categoryId)) delete value.categoryId
            }
            for (const [folder, categoryId] of Object.entries(overrides.folderMap || {})) {
              if (doomed.has(categoryId)) delete overrides.folderMap[folder]
            }
            await saveOverrides(overrides)
            return sendJson(res, 200, { ok: true, removed: doomed.size })
          }

          /** 把一个浏览器文件夹（含子文件夹）整块归到某个分类：写死到每条书签上，并记住规则给新书签用。 */
          if (req.method === 'POST' && route === '/category/assign-folder') {
            const body = await readBody(req)
            const folder = String(body.folder || '')
            const categoryId = String(body.categoryId || '')
            if (!folder) return sendJson(res, 400, { error: 'folder required' })
            const overrides = await loadOverrides()
            const known = new Set(overrides.categories.map((c) => c.id))
            if (categoryId && !known.has(categoryId)) return sendJson(res, 400, { error: 'unknown category' })
            const index = await loadIndex({ force: true })
            let count = 0
            for (const item of index.items) {
              const value = String(item.folder || '')
              if (value !== folder && !value.startsWith(`${folder} / `)) continue
              const next = { ...(overrides.items[item.url] || {}) }
              if (categoryId) next.categoryId = categoryId
              else delete next.categoryId
              if (Object.keys(next).length) overrides.items[item.url] = next
              else delete overrides.items[item.url]
              count += 1
            }
            if (!overrides.folderMap) overrides.folderMap = {}
            if (categoryId) overrides.folderMap[folder] = categoryId
            else delete overrides.folderMap[folder]
            await saveOverrides(overrides)
            const fresh = await loadIndex({ force: true })
            return sendJson(res, 200, { ok: true, count, unclassified: fresh.unclassified })
          }

          if (req.method === 'POST' && route === '/category/assign-item') {
            const body = await readBody(req)
            const url = String(body.url || '')
            const categoryId = String(body.categoryId || '')
            if (!url) return sendJson(res, 400, { error: 'url required' })
            const overrides = await loadOverrides()
            const known = new Set(overrides.categories.map((c) => c.id))
            if (categoryId && !known.has(categoryId)) return sendJson(res, 400, { error: 'unknown category' })
            const next = { ...(overrides.items[url] || {}) }
            if (categoryId) next.categoryId = categoryId
            else delete next.categoryId
            if (Object.keys(next).length) overrides.items[url] = next
            else delete overrides.items[url]
            await saveOverrides(overrides)
            return sendJson(res, 200, { ok: true })
          }

          if (req.method === 'POST' && route === '/pin') {
            const body = await readBody(req)
            const item = body && body.item ? body.item : null
            if (!item || !item.url) return sendJson(res, 400, { error: 'item required' })
            const file = join(DATA_DIR, 'pins.jsonl')
            const line = JSON.stringify({ at: Date.now(), title: item.title, url: item.url, category: item.category, summary: item.desc || item.summary || '' }) + '\n'
            await writeFile(file, line, { flag: 'a', encoding: 'utf8' }).catch(() => {})
            return sendJson(res, 200, { ok: true })
          }

          if (req.method === 'POST' && route === '/open') {
            const body = await readBody(req)
            openExternal(String(body.url || ''))
            return sendJson(res, 200, { ok: true })
          }

          if (req.method === 'POST' && route === '/refresh') {
            const payload = await loadIndex({ force: true })
            return sendJson(res, 200, { ok: true, total: payload.stats.total })
          }

          return sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          return sendJson(res, error.status || 500, { error: error.message || 'failed' })
        }
      },
    }), 'bookmarks-desk: routes')
  },
}
