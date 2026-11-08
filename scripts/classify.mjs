/**
 * 通用批量归类 —— 按你自己在面板里建好的分类，把浏览器书签批量归进去。
 *
 * 不预设任何分类名：判定规则来自三处，谁分高听谁的
 *   1. 文件夹：书签所在文件夹名与分类同名（+10）或互相包含（+6）
 *   2. 自定义规则：--rules 传入的 {分类名: {domains, keywords}}
 *   3. 内置主题词典：分类名里出现「AI / 设计 / 服务器 / 交易…」等主题词时，
 *      自动启用该主题的域名与关键词（域名 +5，关键词 +2，单主题最多 +4）
 *
 * 用法：
 *   node scripts/classify.mjs                    # 只打印分布，不写入
 *   node scripts/classify.mjs --write            # 写入 overrides.json（自动备份）
 *   node scripts/classify.mjs --samples 10       # 每个分类打印 10 条命中样本
 *   node scripts/classify.mjs --inbox 收件箱     # 没命中的归到「收件箱」，不存在就建
 *   node scripts/classify.mjs --rules ./my.json  # 追加自定义规则
 *
 * 归类结果只写 ~/.dsh/bookmarks-desk/overrides.json，不碰浏览器书签文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { __testing } from '../index.js'

const { detectSources } = __testing

const STORE = path.join(os.homedir(), '.dsh', 'bookmarks-desk', 'overrides.json')
const DEFAULT_INBOX = '收件箱'
const THRESHOLD = 4

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const value = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  const next = at >= 0 ? argv[at + 1] : ''
  return next && !next.startsWith('--') ? next : fallback
}

const write = flag('write')
const sampleCount = Number(value('samples', 0)) || 0
const inboxName = value('inbox', DEFAULT_INBOX)
const rulesFile = value('rules', '')

/* ---------------- 主题词典（通用，不含任何个人分类） ---------------- */

const TOPICS = [
  {
    id: 'ai',
    triggers: ['ai', '人工智能', '大模型', '模型', 'aigc', '智能'],
    domains: [/openai|claude\.ai|anthropic|huggingface|modelscope|comfyui|midjourney|chatgpt|gemini|deepseek|suno\.|runwayml|kimi\.|doubao/i],
    keywords: ['模型', '提示词', '智能体', '大模型', '推理', '微调', '绘画', '生成'],
  },
  {
    id: 'code',
    triggers: ['代码', '开发', '编程', 'github', 'git', '前端', '后端', '程序', '工程'],
    domains: [/github\.com|gitlab\.com|gitee\.com|stackoverflow|npmjs\.com|crates\.io|pypi\.org|vercel\.com|netlify/i],
    keywords: ['开源', '仓库', '源码', 'sdk', 'api', '组件', '框架', '代码'],
  },
  {
    id: 'media',
    triggers: ['视频', '影视', '影音', '电影', '番剧', '音乐', '音频', 'youtube', 'b站'],
    domains: [/youtube\.com|youtu\.be|bilibili\.com|douyin|iqiyi|youku|v\.qq\.com|mgtv|netflix|spotify|music\.163/i],
    keywords: ['电影', '影视', '动漫', '番剧', '音乐', '直播', '剧集', '视频'],
  },
  {
    id: 'design',
    triggers: ['设计', 'ui', 'ux', 'figma', '配色', '字体', '视觉'],
    domains: [/figma\.com|dribbble|behance|pinterest|unsplash|iconfont|coolors/i],
    keywords: ['设计', '配色', '字体', '图标', '视觉', '排版', '原型'],
  },
  {
    id: 'infra',
    triggers: ['服务器', '运维', 'vps', '云', '网络', '部署', 'docker', 'linux', 'nas'],
    domains: [/cloudflare|vultr|digitalocean|aliyun|tencentcloud|bandwagon|railway\.app|fly\.io/i],
    keywords: ['服务器', '域名', '节点', '代理', '内网', '端口', '宝塔', 'docker', '部署', '运维'],
  },
  {
    id: 'learn',
    triggers: ['学习', '教程', '课程', '文档', '教育', '资料'],
    domains: [/docs\.|wiki|notion\.so|yuque\.com|juejin\.cn|segmentfault|coursera|udemy|developer\.mozilla/i],
    keywords: ['教程', '课程', '文档', '学习', '入门', '指南', '手册'],
  },
  {
    id: 'tools',
    triggers: ['工具', '软件', '下载', '效率', '插件', 'app'],
    domains: [/download|softonic|portable/i],
    keywords: ['软件', '下载', '工具', '插件', '扩展', '客户端'],
  },
  {
    id: 'assets',
    triggers: ['资源', '素材', '网盘', '模板', '字体库'],
    domains: [/pan\.(quark|baidu)|aliyundrive|123pan|drive\.google|mega\.nz/i],
    keywords: ['资源', '素材', '模板', '贴图', '预设', '网盘'],
  },
  {
    id: 'trade',
    triggers: ['交易', '投资', '股票', '加密', '币', '金融', '理财', '行情'],
    domains: [/binance|okx|coinbase|tradingview|investing\.com|eastmoney|xueqiu/i],
    keywords: ['交易', '行情', '投资', '股票', '基金', '合约', 'k线'],
  },
  {
    id: 'shopping',
    triggers: ['购物', '电商', '商城', '跨境', '买'],
    domains: [/taobao|tmall|jd\.com|1688\.com|pinduoduo|amazon\.|ozon|shopify/i],
    keywords: ['购物', '电商', '店铺', '选品', '订单', '支付'],
  },
]

/* ---------------- 工具函数 ---------------- */

const norm = (text) => String(text || '').toLowerCase().replace(/[\s\-_/·]+/g, '')

/** 分类名切成词：AI-工具 → [ai, 工具]，学习教程 → [学习教程] */
function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
}

function hostLabels(url) {
  try {
    return new URL(url).hostname.toLowerCase().split('.')
  } catch {
    return []
  }
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function hostMatches(url, domain) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    const target = String(domain).toLowerCase().replace(/^www\./, '')
    return host === target || host.endsWith(`.${target}`)
  } catch {
    return false
  }
}

/** 分类名里出现了哪些主题词 → 启用对应词典 */
function activeTopics(categoryName) {
  const name = norm(categoryName)
  return TOPICS.filter((topic) => topic.triggers.some((word) => name.includes(norm(word))))
}

function customRulesFor(rules, categoryName) {
  if (!rules || !rules.categories) return null
  const wanted = norm(categoryName)
  for (const [key, rule] of Object.entries(rules.categories)) {
    if (norm(key) === wanted) return rule || null
  }
  return null
}

function scoreFor(entry, category, topics, custom) {
  let score = 0
  const hits = []
  const catName = norm(category.name)
  const segments = String(entry.folder || '').split(' / ').map((part) => part.trim()).filter(Boolean)

  if (catName && segments.some((part) => norm(part) === catName)) {
    score += 10
    hits.push('folder=')
  } else if (catName && segments.some((part) => norm(part).includes(catName) || catName.includes(norm(part)))) {
    score += 6
    hits.push('folder~')
  }

  // 分类名里的词直接命中域名或标题：Github → github.com，YouTube → youtube.com
  const title = String(entry.title || '').toLowerCase()
  const labels = hostLabels(entry.url)
  for (const token of nameTokens(category.name)) {
    if (labels.includes(token)) {
      score += 8
      hits.push(`name@${token}`)
      break
    }
    const inTitle = /^[\x20-\x7e]+$/.test(token)
      ? new RegExp(`\\b${escapeRe(token)}\\b`, 'i').test(title)
      : title.includes(token)
    if (inTitle) {
      score += 4
      hits.push(`title@${token}`)
      break
    }
  }

  if (custom) {
    for (const domain of custom.domains || []) {
      if (hostMatches(entry.url, domain)) {
        score += 6
        hits.push(`rule:${domain}`)
      }
    }
    for (const keyword of custom.keywords || []) {
      if (title.includes(String(keyword).toLowerCase())) {
        score += 2
        hits.push(`rule:${keyword}`)
      }
    }
  }

  for (const topic of topics) {
    if (topic.domains.some((re) => re.test(entry.url))) {
      score += 5
      hits.push(`${topic.id}:domain`)
    }
    let keywordHits = 0
    for (const keyword of topic.keywords) {
      if (!title.includes(keyword.toLowerCase())) continue
      keywordHits += 1
      hits.push(`${topic.id}:${keyword}`)
    }
    score += Math.min(keywordHits, 2) * 2
  }

  return { score, hits }
}

/* ---------------- 读数据 ---------------- */

if (!fs.existsSync(STORE)) {
  console.error(`没找到 ${STORE}\n先在面板里建几个分类，或用 DSH 打开一次插件。`)
  process.exit(1)
}

const overrides = JSON.parse(fs.readFileSync(STORE, 'utf8'))
overrides.items = overrides.items || {}
overrides.categories = overrides.categories || []
overrides.folderMap = overrides.folderMap || {}

let rules = null
if (rulesFile) {
  rules = JSON.parse(fs.readFileSync(path.resolve(rulesFile), 'utf8'))
}

const sources = await detectSources()
if (!sources.length) {
  console.error('没读到任何浏览器书签。检查浏览器是否装在本机默认位置，或用 BOOKMARKS_DESK_BROWSERS 指定。')
  process.exit(1)
}

const entries = []
const seen = new Set()
for (const source of sources) {
  for (const item of source.items) {
    if (!item.url || /^javascript:/i.test(item.url)) continue
    if (seen.has(item.url)) continue
    seen.add(item.url)
    entries.push({ ...item, source: source.id })
  }
}

/* ---------------- 准备分类 ---------------- */

let categories = overrides.categories.map((cat) => ({ ...cat }))
const findCategory = (name) => categories.find((cat) => norm(cat.name) === norm(name))

let inbox = findCategory(inboxName)
const inboxRequested = Boolean(inboxName) && (flag('inbox') || categories.length === 0)
if (!inbox && inboxRequested) {
  inbox = {
    id: `custom-inbox-${Date.now().toString(36)}`,
    name: inboxName,
    color: '#8a8f98',
    order: categories.length,
    parentId: '',
  }
  categories.push(inbox)
}

if (!categories.length) {
  console.error(`当前还没有任何分类。先执行：node scripts/classify.mjs --inbox ${DEFAULT_INBOX} --write`)
  process.exit(1)
}

const scoring = categories.map((cat) => ({
  cat,
  topics: activeTopics(cat.name),
  custom: customRulesFor(rules, cat.name),
}))

/* ---------------- 打分 ---------------- */

const resolved = []
const counts = {}
for (const entry of entries) {
  let best = null
  for (const { cat, topics, custom } of scoring) {
    if (inbox && cat.id === inbox.id) continue
    const { score, hits } = scoreFor(entry, cat, topics, custom)
    if (score < THRESHOLD) continue
    if (!best || score > best.score) best = { cat, score, hits }
  }
  const target = best ? best.cat : inbox
  if (!target) continue
  counts[target.name] = (counts[target.name] || 0) + 1
  resolved.push({
    url: entry.url,
    title: entry.title,
    folder: entry.folder,
    categoryId: target.id,
    categoryName: target.name,
    score: best ? best.score : 0,
    hits: best ? best.hits : ['inbox'],
  })
}

const skipped = entries.length - resolved.length

/* ---------------- 文件夹映射 ---------------- */

const byFolder = new Map()
for (const row of resolved) {
  if (!row.folder || row.hits.includes('inbox')) continue
  if (!byFolder.has(row.folder)) byFolder.set(row.folder, [])
  byFolder.get(row.folder).push(row)
}

let mapped = 0
const nextFolderMap = { ...overrides.folderMap }
for (const [folder, list] of byFolder) {
  if (list.length < 4) continue
  const tally = {}
  for (const row of list) tally[row.categoryId] = (tally[row.categoryId] || 0) + 1
  const [id, hits] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0]
  if (hits / list.length < 0.7) continue
  if (inbox && id === inbox.id) continue
  if (nextFolderMap[folder] === id) continue
  nextFolderMap[folder] = id
  mapped += 1
}

/* ---------------- 输出 ---------------- */

console.log(`读到的浏览器：${sources.map((s) => `${s.label}(${s.items.length})`).join(', ')}`)
console.log(`书签总数：${entries.length}　可归类：${resolved.length}　跳过：${skipped}`)
console.log('--- 分布 ---')
for (const [name, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(String(n).padStart(5), name)
}

if (sampleCount > 0) {
  console.log('\n--- 抽样 ---')
  for (const name of Object.keys(counts).sort()) {
    const list = resolved.filter((row) => row.categoryName === name).slice(0, sampleCount)
    console.log(`\n## ${name}`)
    for (const row of list) {
      const folder = String(row.folder || '').replace(/^书签栏\s*\/\s*/, '')
      console.log(`  - ${(row.title || '(无标题)').slice(0, 44)}  |  ${folder}  |  ${row.score} ${row.hits.slice(0, 3).join(',')}`)
    }
  }
}

if (!write) {
  console.log('\n[dry-run] 没有写入。确认分布没问题后加 --write 执行。')
  process.exit(0)
}

let changed = 0
for (const row of resolved) {
  const prev = overrides.items[row.url] || {}
  if (prev.categoryId === row.categoryId) continue
  overrides.items[row.url] = { ...prev, categoryId: row.categoryId }
  changed += 1
}

const addedCategories = categories.filter((cat) => !overrides.categories.some((old) => old.id === cat.id))
if (addedCategories.length) overrides.categories.push(...addedCategories)
overrides.folderMap = nextFolderMap
overrides.rev = (Number(overrides.rev) || 0) + 1

const backup = `${STORE}.bak-${Date.now()}`
fs.copyFileSync(STORE, backup)
fs.writeFileSync(STORE, JSON.stringify(overrides, null, 2), 'utf8')

console.log('\n--- 已写入 ---')
console.log('归类更新:', changed, '条')
console.log('新增分类:', addedCategories.map((cat) => cat.name).join(', ') || '（无）')
console.log('folderMap 新增规则:', mapped, '条')
console.log('备份:', backup)
console.log('重启 DSH（或面板点刷新）后生效。')
