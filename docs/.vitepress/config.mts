import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'vrev',
  description: 'HTML・画像・ローカルWebアプリへ注釈を付け、coding agentによる修正やGitHub Issue作成につなげるローカルVrevツール',
  base: '/vrev/',
  themeConfig: {
    nav: [
      { text: 'ガイド', link: '/plugin-guide' },
      { text: 'プラグイン基盤', link: '/plugins' },
    ],
    sidebar: [
      {
        text: 'はじめに',
        items: [
          { text: 'プラグイン開発ガイド', link: '/plugin-guide' },
          { text: 'プラグイン基盤', link: '/plugins' },
        ],
      },
      {
        text: 'リファレンス',
        items: [
          { text: 'UI ブリッジ', link: '/plugin-ui-bridge' },
          { text: 'Plugin Host アーキテクチャ', link: '/plugin-host-architecture' },
          { text: 'Storage Providers', link: '/storage-providers' },
          { text: 'リリース手順', link: '/releasing' },
          { text: 'ロードマップ', link: '/roadmap' },
          { text: 'Gotchas', link: '/gotchas' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/NAKAK10/vrev' }],
  },
})
