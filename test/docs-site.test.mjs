import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import test from 'node:test'

const root = resolve('docs/.vitepress/dist')
const locales = [['', 'ja'], ['en/', 'en'], ['zh/', 'zh-CN']]
const readPage = (path) => readFileSync(resolve(root, path), 'utf8')

function htmlFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? htmlFiles(path) : entry.name.endsWith('.html') ? [path] : []
  })
}

test('localized home pages render meaningful HTML before hydration', () => {
  for (const [prefix, lang] of locales) {
    const html = readPage(`${prefix}index.html`)
    assert.ok(html.includes(`lang="${lang}"`), lang)
    assert.equal((html.match(/<h1\b/g) || []).length, 1, lang)
    assert.ok(html.includes('<main class="landing"'), lang)
    for (const page of ['getting-started', 'workflow', 'developers']) {
      assert.ok(html.includes(`href="/vrev/${prefix}${page}"`), `${lang}: ${page}`)
    }
  }
})

test('every Japanese document has a safe language-switch destination', () => {
  for (const entry of readdirSync('docs').filter(name => name.endsWith('.md'))) {
    for (const [prefix] of locales) {
      assert.ok(existsSync(resolve(root, prefix, entry.replace(/\.md$/, '.html'))), `${prefix}${entry}`)
    }
  }
})

test('all generated local navigation and asset links resolve under the Pages base', () => {
  for (const path of htmlFiles(root)) {
    const html = readFileSync(path, 'utf8')
    for (const [, raw] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(raw)) continue
      const url = new URL(raw.replaceAll('&amp;', '&'), `https://example.test/vrev/${relative(root, path)}`)
      assert.ok(url.pathname.startsWith('/vrev/'), `${path}: escaped base: ${raw}`)
      const target = resolve(root, decodeURIComponent(url.pathname.slice('/vrev/'.length)))
      assert.ok([target, `${target}.html`, resolve(target, 'index.html')].some(existsSync), `${relative(root, path)}: ${raw}`)
    }
  }
})

test('untranslated technical references explicitly disclose their language', () => {
  assert.match(readPage('en/plugin-guide.html'), /has not been translated into English yet/)
  assert.match(readPage('zh/plugin-guide.html'), /尚未翻译为简体中文/)
  for (const prefix of ['en/', 'zh/']) {
    assert.ok(readPage(`${prefix}plugin-guide.html`).includes('href="/vrev/plugin-guide"'))
  }
})
