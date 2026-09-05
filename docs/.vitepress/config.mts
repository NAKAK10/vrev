import { defineConfig, type DefaultTheme } from 'vitepress'

const github = 'https://github.com/NAKAK10/vrev'
function theme(locale: 'ja' | 'en' | 'zh'): DefaultTheme.Config {
  const prefix = locale === 'ja' ? '/' : `/${locale}/`
  const t = {
    ja: { start: 'はじめる', guide: '使い方', dev: '開発者向け', reference: '技術リファレンス', intro: '概要', quick: 'クイックスタート', workflow: 'レビューワークフロー', resources: '開発者ガイド', outline: 'このページの内容', prev: '前のページ', next: '次のページ', search: 'ドキュメントを検索', menu: 'メニュー', top: 'ページ上部へ', lang: '言語', appearance: 'テーマ', light: 'ライトモードに切り替え', dark: 'ダークモードに切り替え' },
    en: { start: 'Get started', guide: 'User guide', dev: 'Developers', reference: 'Technical reference', intro: 'Overview', quick: 'Quick start', workflow: 'Review workflow', resources: 'Developer guide', outline: 'On this page', prev: 'Previous page', next: 'Next page', search: 'Search docs', menu: 'Menu', top: 'Back to top', lang: 'Language', appearance: 'Appearance', light: 'Switch to light theme', dark: 'Switch to dark theme' },
    zh: { start: '快速开始', guide: '使用指南', dev: '开发者', reference: '技术参考', intro: '概览', quick: '快速入门', workflow: '审阅工作流', resources: '开发者指南', outline: '本页目录', prev: '上一页', next: '下一页', search: '搜索文档', menu: '菜单', top: '返回顶部', lang: '语言', appearance: '主题', light: '切换到浅色主题', dark: '切换到深色主题' },
  }[locale]
  const reference = [
    { text: 'プラグイン開発ガイド', link: '/plugin-guide' },
    { text: 'プラグイン基盤', link: '/plugins' },
    { text: 'UI ブリッジ', link: '/plugin-ui-bridge' },
    { text: 'Plugin Host', link: '/plugin-host-architecture' },
    { text: 'Storage Providers', link: '/storage-providers' },
    { text: 'リリース手順', link: '/releasing' },
    { text: 'ロードマップ', link: '/roadmap' },
    { text: 'トラブルシューティング', link: '/gotchas' },
  ]
  return {
    logo: '/logo.svg', siteTitle: 'vrev',
    nav: [
      { text: t.start, link: `${prefix}getting-started`, activeMatch: `${prefix}getting-started` },
      { text: t.guide, link: `${prefix}workflow`, activeMatch: `${prefix}workflow` },
      { text: t.dev, link: `${prefix}developers`, activeMatch: `${prefix}(developers|plugin|storage|releasing|roadmap|gotchas)` },
    ],
    sidebar: [
      { text: t.start, items: [{ text: t.intro, link: prefix }, { text: t.quick, link: `${prefix}getting-started` }, { text: t.workflow, link: `${prefix}workflow` }] },
      { text: t.dev, items: [{ text: t.resources, link: `${prefix}developers` }] },
      ...(locale === 'ja' ? [{ text: t.reference, collapsed: false, items: reference }] : []),
    ],
    outline: { level: [2, 3], label: t.outline },
    docFooter: { prev: t.prev, next: t.next },
    sidebarMenuLabel: t.menu, returnToTopLabel: t.top, langMenuLabel: t.lang,
    darkModeSwitchLabel: t.appearance, lightModeSwitchTitle: t.light, darkModeSwitchTitle: t.dark,
    skipToContentLabel: locale === 'ja' ? '本文へスキップ' : locale === 'zh' ? '跳转到正文' : 'Skip to content',
    socialLinks: [{ icon: 'github', link: github }],
    editLink: { pattern: `${github}/edit/main/docs/:path`, text: locale === 'ja' ? 'GitHub でこのページを編集' : locale === 'zh' ? '在 GitHub 上编辑此页' : 'Edit this page on GitHub' },
    footer: { message: 'Released under the MIT License.', copyright: 'vrev · Local review, connected.' },
    search: { provider: 'local', options: { locales: {
      root: { translations: { button: { buttonText: '検索', buttonAriaLabel: 'ドキュメントを検索' }, modal: { noResultsText: '結果が見つかりません', resetButtonTitle: '検索をクリア', displayDetails: '詳細を表示', footer: { selectText: '選択', navigateText: '移動', closeText: '閉じる' } } } },
      zh: { translations: { button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' }, modal: { noResultsText: '未找到结果', resetButtonTitle: '清除搜索', displayDetails: '显示详情', footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' } } } },
    } } },
  }
}

export default defineConfig({
  title: 'vrev',
  description: '画面上のフィードバックを、AI による修正と GitHub Issue へ。ローカルで使えるビジュアルレビューツール。',
  base: '/vrev/',
  cleanUrls: true,
  themeConfig: theme('ja'),
  head: [['meta', { name: 'theme-color', content: '#087f73' }], ['link', { rel: 'icon', href: '/vrev/logo.svg', type: 'image/svg+xml' }]],
  locales: {
    root: { label: '日本語', lang: 'ja', themeConfig: theme('ja') },
    en: { label: 'English', lang: 'en', description: 'Turn visual feedback into AI-assisted fixes and GitHub Issues. A local-first review tool.', themeConfig: theme('en') },
    zh: { label: '简体中文', lang: 'zh-CN', description: '将页面反馈转化为 AI 辅助修改和 GitHub Issue。本地优先的可视化审阅工具。', themeConfig: theme('zh') },
  },
})
