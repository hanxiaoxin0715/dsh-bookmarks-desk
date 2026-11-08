/**
 * bookmarks-desk — Client 半面（v9：参考 HTML 原样嵌入）。
 *
 * 视图层完全交给 panel/index.html（参考页 1:1），这里只做三件事：
 * 取真实书签 → postMessage 注入 iframe → 接住它的 open / session / memory 动作。
 */
window.__ModuleLoader__.load({
  id: 'dsh-bookmarks-desk',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useMemo, useCallback, useRef } = React

    const PANEL_ID = 'bookmarks'
    const ENDPOINT = '/bookmarks-desk'

    const STYLE = {
      ai: { dot: 'bg-violet-400', a1: 'bg-violet-600/35', a2: 'bg-cyan-500/25', hex: '#A78BFA' },
      dev: { dot: 'bg-emerald-400', a1: 'bg-emerald-600/30', a2: 'bg-teal-500/20', hex: '#34D399' },
      media: { dot: 'bg-amber-400', a1: 'bg-amber-500/30', a2: 'bg-rose-600/25', hex: '#FBBF24' },
      soft: { dot: 'bg-fuchsia-400', a1: 'bg-fuchsia-600/30', a2: 'bg-indigo-600/25', hex: '#E879F9' },
      infra: { dot: 'bg-sky-400', a1: 'bg-sky-600/30', a2: 'bg-blue-600/25', hex: '#38BDF8' },
      assets: { dot: 'bg-rose-400', a1: 'bg-rose-600/30', a2: 'bg-orange-500/20', hex: '#FB7185' },
      learn: { dot: 'bg-cyan-400', a1: 'bg-cyan-600/30', a2: 'bg-sky-500/20', hex: '#22D3EE' },
      biz: { dot: 'bg-orange-400', a1: 'bg-orange-600/30', a2: 'bg-amber-500/20', hex: '#FB923C' },
      life: { dot: 'bg-zinc-400', a1: 'bg-zinc-600/30', a2: 'bg-slate-500/20', hex: '#A1A1AA' },
    }
    const STYLE_ALL = { dot: 'bg-indigo-400', a1: 'bg-indigo-600/30', a2: 'bg-fuchsia-600/20', hex: '#818CF8' }

    function relText(ms) {
      if (!ms) return ''
      const diff = Date.now() - ms
      const day = 86400000
      if (diff < day) return '今天'
      if (diff < day * 2) return '昨天'
      if (diff < day * 30) return `${Math.floor(diff / day)} 天前`
      if (diff < day * 365) return `${Math.floor(diff / (day * 30))} 个月前`
      return `${Math.floor(diff / (day * 365))} 年前`
    }

    function splitFrames(item) {
      const tags = Array.isArray(item.tags) && item.tags.length ? item.tags : []
      const pieces = String(item.summary || item.title || '').split(/[。；;]/).map((s) => s.trim()).filter(Boolean)
      const frames = []
      for (let i = 0; i < 4; i++) {
        const label = tags[i % Math.max(1, tags.length)] || pieces[i] || '预览分段'
        const prompt = pieces[i] || item.summary || item.title || ''
        frames.push({
          time: `00:0${i + 1}.0${i * 2}`,
          cam: String(label).slice(0, 22),
          prompt: String(prompt).slice(0, 60) || '—',
          gradient: [
            'from-amber-500/40 via-orange-600/30 to-rose-900/60',
            'from-cyan-500/40 via-blue-700/30 to-indigo-950/70',
            'from-fuchsia-500/40 via-purple-700/30 to-slate-950/70',
            'from-emerald-500/40 via-teal-700/30 to-zinc-950/70',
          ][i],
        })
      }
      return frames
    }

    function buildPayload(data, sourceId) {
      const scoped = data.items.filter((item) => !sourceId || sourceId === 'all' || item.source === sourceId)
      const byCategory = new Map()
      for (const item of scoped) byCategory.set(item.categoryId, (byCategory.get(item.categoryId) || 0) + 1)

      const categories = [
        { id: 'all', name: '全部星系', count: scoped.length, dot: STYLE_ALL.dot, aurora1: STYLE_ALL.a1, aurora2: STYLE_ALL.a2, hex: STYLE_ALL.hex },
        ...data.categories
          .filter((c) => (byCategory.get(c.id) || 0) > 0)
          .map((c) => ({
            id: c.name,
            name: c.name,
            count: byCategory.get(c.id) || 0,
            dot: (STYLE[c.id] || STYLE.life).dot,
            aurora1: (STYLE[c.id] || STYLE.life).a1,
            aurora2: (STYLE[c.id] || STYLE.life).a2,
            hex: (STYLE[c.id] || STYLE.life).hex,
          })),
      ]

      const nameById = new Map(data.categories.map((c) => [c.id, c.name]))
      const items = scoped.map((item, index) => {
        const categoryName = nameById.get(item.categoryId) || '生活与其他'
        const isRepo = /(^|\.)(github\.com|gitlab\.com|gitee\.com)$/.test(item.host || '')
        let visualType = 'shader'
        if (isRepo) visualType = 'github'
        else if (categoryName === '影视与音视频') visualType = 'storyboard'
        else if (categoryName === 'AI 与模型' || categoryName === '开发与代码' || categoryName === '软件与工具') visualType = 'shader'

        return {
          id: index + 1,
          title: item.title,
          shortName: (item.host || '').split('.')[0].replace(/^./, (c) => c.toUpperCase()).slice(0, 10) || (item.title || '').slice(0, 10),
          subLabel: categoryName,
          domain: item.host || '',
          url: item.url,
          category: categoryName,
          categoryId: item.categoryId || '',
          categorySource: item.categorySource || '',
          time: relText(item.added),
          added: item.added || 0,
          folder: item.folder || '',
          tags: Array.isArray(item.tags) ? item.tags : [],
          enriched: Boolean(item.enriched),
          year: item.added ? String(new Date(item.added).getFullYear()) : '',
          source: item.sourceLabel === 'Edge' ? 'Edge' : 'Chrome',
          bentoSpan: index % 6 === 0 ? 'md:col-span-2' : 'col-span-1',
          visualType,
          repoMeta: isRepo ? { stars: '—', forks: '—', lang: 'Repository', cmd: `git clone ${item.url.replace(/\/$/, '')}.git` } : undefined,
          frames: visualType === 'storyboard' ? splitFrames(item) : undefined,
          shaderTheme: (STYLE[item.categoryId] || STYLE.life).a1 + ' via-indigo-600/30 to-cyan-500/30',
          badge: (item.tags && item.tags[0]) || item.host,
          desc: item.summary || '',
          aiTakeaways: item.tags && item.tags.length ? item.tags.slice(0, 4) : [item.summary || item.title],
          inbox: !item.enriched,
        }
      })

      return {
        categories,
        categoryDefs: Array.isArray(data.categories) ? data.categories : [],
        manual: Boolean(data.manual),
        unclassified: Number(data.unclassified) || 0,
        folderMap: data.folderMap && typeof data.folderMap === 'object' ? data.folderMap : {},
        items,
        sources: Array.isArray(data.sources) ? data.sources : [],
        stats: data.stats || { total: items.length },
        builtAt: data.builtAt || 0,
      }
    }

    function useDesk() {
      const [state, setState] = useState({ loading: true, error: null, data: null })
      const load = useCallback(async () => {
        try {
          const response = await fetch(`${ENDPOINT}/state`, { credentials: 'same-origin' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          setState({ loading: false, error: null, data: await response.json() })
        } catch (error) {
          setState({ loading: false, error: String(error && error.message ? error.message : error), data: null })
        }
      }, [])
      useEffect(() => { load() }, [load])
      return { ...state, reload: load }
    }

    function Page() {
      const { loading, error, data, reload } = useDesk()
      const frameRef = useRef(null)
      const [ready, setReady] = useState(false)

      const payload = useMemo(() => (data ? buildPayload(data, null) : null), [data])
      // iframe 地址必须稳定：如果每次 render 都换 ?v=，ready 一到就会重载 iframe，数据永远送不进去
      const frameSrc = useMemo(() => `${ENDPOINT}/panel/?v=${Date.now()}`, [])
      const payloadRef = useRef(null)
      payloadRef.current = payload

      useEffect(() => {
        const onMessage = (event) => {
          const message = event.data
          if (!message || message.source !== 'bookmarks-desk') return
          const frame = frameRef.current
          const reply = (text) => {
            if (frame && frame.contentWindow) {
              frame.contentWindow.postMessage({ source: 'dsh-host', type: 'toast', message: text }, '*')
            }
          }
          if (message.type === 'ready') {
            setReady(true)
            // 面板每次 ready 都补发一次数据，避免 iframe 重载/首次握手时机错位
            const win = frame && frame.contentWindow
            if (win && payloadRef.current) {
              win.postMessage({ source: 'dsh-host', type: 'data', payload: payloadRef.current }, '*')
            }
            return
          }
          if (message.type === 'refresh') {
            fetch(`${ENDPOINT}/refresh`, { method: 'POST', credentials: 'same-origin' })
              .catch(() => {})
              .then(() => reload())
            return
          }
          if (message.type === 'open' && message.url) {
            fetch(`${ENDPOINT}/open`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ url: message.url }),
            }).catch(() => {})
            return
          }
          if (message.type === 'session' && message.item) {
            const text = `${message.item.title}\n${message.item.url}\n${message.item.desc || ''}`
            try {
              navigator.clipboard.writeText(text)
              reply('已复制这条收藏（标题＋链接＋简介），去新会话粘贴即可')
            } catch (e) {
              reply('浏览器拒绝了剪贴板写入')
            }
            return
          }
          if (message.type === 'memory' && message.item) {
            fetch(`${ENDPOINT}/pin`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({ item: message.item }),
            }).then(() => reply('已记到本地收藏备注（~/.dsh/bookmarks-desk/pins.jsonl）')).catch(() => reply('记录失败'))
          }
          if (message.type === 'classify') {
            fetch(`${ENDPOINT}/classify/start`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              credentials: 'same-origin',
              body: JSON.stringify({}),
            }).then(() => {
              let tries = 0
              const timer = setInterval(async () => {
                tries += 1
                try {
                  const response = await fetch(`${ENDPOINT}/classify/status`, { credentials: 'same-origin' })
                  const status = await response.json()
                  if (!status.running) {
                    clearInterval(timer)
                    if (status.error) reply(`补齐简介中断：${status.error}`)
                    else reply(`简介已补齐 ${status.done || 0} 条`)
                    reload()
                    return
                  }
                } catch (error) {
                  /* 网络抖动就继续等下一轮 */
                }
                if (tries > 120) clearInterval(timer)
              }, 3000)
            }).catch(() => reply('无法启动补齐任务'))
            return
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [reload])

      useEffect(() => {
        if (!ready || !payload) return
        const frame = frameRef.current
        if (!frame || !frame.contentWindow) return
        frame.contentWindow.postMessage({ source: 'dsh-host', type: 'data', payload }, '*')
      }, [ready, payload])

      if (error) {
        return h('div', { style: { padding: 24, color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, `读取收藏夹失败：${error}`)
      }

      return h('div', { style: { position: 'relative', width: '100%', height: '100%', background: '#050508' } },
        h('iframe', {
          ref: frameRef,
          src: frameSrc,
          onLoad: () => {
            const win = frameRef.current && frameRef.current.contentWindow
            if (win && payloadRef.current) {
              win.postMessage({ source: 'dsh-host', type: 'data', payload: payloadRef.current }, '*')
            }
          },
          title: '星河书签',
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: '#050508' },
          allow: 'clipboard-write',
        }),
        loading
          ? h('div', {
            style: {
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'rgba(255,255,255,.55)', fontSize: 12, background: '#050508', pointerEvents: 'none',
            },
          }, '正在读取书签…')
          : null,
      )
    }

    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      const active = !!(props && props.active)
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.15, strokeLinejoin: 'round',
        'aria-hidden': true, focusable: false, style: { display: 'block', opacity: active ? 1 : 0.82 },
      },
        h('ellipse', { cx: 8, cy: 8, rx: 6.4, ry: 2.7, transform: 'rotate(-28 8 8)', opacity: active ? 0.95 : 0.8 }),
        h('ellipse', { cx: 8, cy: 8, rx: 2.7, ry: 6.4, transform: 'rotate(-28 8 8)', opacity: 0.38, strokeWidth: 0.9 }),
        h('circle', { cx: 8, cy: 8, r: active ? 2.15 : 1.9, fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: 12.9, cy: 4.2, r: 0.95, fill: 'currentColor', stroke: 'none', opacity: 0.9 }),
        h('circle', { cx: 3.3, cy: 12.2, r: 0.62, fill: 'currentColor', stroke: 'none', opacity: 0.55 }),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 7, label: () => '星河书签' }, PanelIcon),
        )
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, Page))
      },
    }
  },
})
