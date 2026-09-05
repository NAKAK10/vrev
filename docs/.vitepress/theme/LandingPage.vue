<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'
const { lang } = useData()
const locale = computed(() => lang.value === 'en' ? 'en' : lang.value === 'zh-CN' ? 'zh' : 'ja')
const link = (page: string) => withBase(`${locale.value === 'ja' ? '/' : `/${locale.value}/`}${page}`)
const copy = {
  ja: {
    badge: 'LOCAL-FIRST VISUAL REVIEW', title: '「ここを直したい」を、', accent: '次のアクションへ。',
    lead: '画面に注釈をつける。AI に修正を依頼する。Issue として共有する。いつもの開発環境で、レビューから改善までをひとつに。', start: '使い始める', source: 'GitHub で見る', note: 'オープンソース · Node.js 20+ · v1.0.0-beta.2',
    preview: 'レビューワークフローのイメージ', mode: 'ビジュアルレビュー', target: 'ローカルアプリ', page: 'あなたの次のアイデアを、形に。', pageSub: 'チームのための、新しいワークスペース。', button: '無料ではじめる', comment: 'このボタンを、もう少し目立たせたい。', selected: '要素を選択', annotation: '注釈 #01', status: 'レビュー中', agent: 'AI に修正を依頼', issue: 'GitHub Issue にする', ready: 'フィードバックを、実装につなげる',
    targets: 'レビューする対象を選ばない', formats: ['静的 HTML', '画像・スクリーンショット', 'localhost アプリ', 'HTTPS ステージング'],
    eyebrow: 'LESS FRICTION, MORE CLARITY', heading: '伝える、直す、共有する。', description: '曖昧な説明やツールの行き来を減らし、画面を見ながら改善を進められます。',
    features: [
      { icon: '01', title: '場所まで伝わるフィードバック', text: 'DOM ノードや矩形範囲を選んで注釈を追加。PC・タブレット・スマートフォン表示を切り替えて、気になる部分を具体的に伝えられます。', tag: '画面上で注釈' },
      { icon: '02', title: '使い慣れた AI と、そのまま', text: 'Claude、Codex、OpenCode、GitHub Copilot、Pi、カスタム CLI に対応。レビュー内容を coding agent による修正へつなげます。', tag: 'AI による修正' },
      { icon: '03', title: '指摘を、置き去りにしない', text: 'スレッド・状態・履歴で対応を追跡。AI が生成した Issue の下書きを確認・編集し、GitHub へ共有できます。', tag: '履歴と Issue' },
    ],
    flowLabel: 'YOUR REVIEW LOOP', flowTitle: 'いつもの開発に、3 ステップ。', steps: [
      ['対象を開く', 'HTML、画像、起動済みのアプリを指定して vrev を起動。'],
      ['気になる場所に注釈', '要素や範囲を選んで、変更したい内容を記録。'],
      ['修正や Issue へつなぐ', 'AI に修正を依頼するか、下書きを確認して Issue を作成。'],
    ], terminal: '起動済みのアプリをレビュー', terminalNote: 'インストール方法と必要環境はクイックスタートへ。', quick: 'クイックスタートを読む',
    extend: 'MAKE IT YOURS', extendTitle: 'チームのワークフローに合わせて拡張。', extendText: 'レビュー、AI、ストレージをプラグインで構成。開発者ガイドから、独自の機能を追加するための仕組みを確認できます。', dev: '開発者ガイド', end: '次のレビューは、画面から。', endText: 'まずはローカルのページをひとつ開いてみましょう。',
  },
  en: {
    badge: 'LOCAL-FIRST VISUAL REVIEW', title: 'From “fix this”', accent: 'to the next action.',
    lead: 'Annotate the screen. Ask AI for a fix. Share a GitHub Issue. Connect feedback to improvements without leaving your development workflow.', start: 'Get started', source: 'View on GitHub', note: 'Open source · Node.js 20+ · v1.0.0-beta.2',
    preview: 'Illustration of the review workflow', mode: 'Visual review', target: 'Local app', page: 'Give your next idea a home.', pageSub: 'A new workspace for your team.', button: 'Start for free', comment: 'Let’s make this button stand out more.', selected: 'Select element', annotation: 'Annotation #01', status: 'In review', agent: 'Ask AI for a fix', issue: 'Create GitHub Issue', ready: 'Turn feedback into implementation',
    targets: 'REVIEW WHERE YOU BUILD', formats: ['Static HTML', 'Images & screenshots', 'Localhost apps', 'HTTPS staging'],
    eyebrow: 'LESS FRICTION, MORE CLARITY', heading: 'Show it. Fix it. Share it.', description: 'Less guesswork and tool switching. Move improvements forward with the screen as your shared context.',
    features: [
      { icon: '01', title: 'Feedback with a precise location', text: 'Annotate DOM nodes or rectangular regions. Switch between desktop, tablet, and mobile viewports to point out exactly what needs to change.', tag: 'Visual annotations' },
      { icon: '02', title: 'The AI tools you already use', text: 'Work with Claude, Codex, OpenCode, GitHub Copilot, Pi, or a custom CLI. Turn review feedback into coding-agent-assisted fixes.', tag: 'AI-assisted fixes' },
      { icon: '03', title: 'Keep every comment moving', text: 'Track threads, statuses, and history. Review and edit an AI-generated Issue draft before sharing it on GitHub.', tag: 'History & Issues' },
    ],
    flowLabel: 'YOUR REVIEW LOOP', flowTitle: 'Three steps. One workflow.', steps: [
      ['Open a target', 'Start vrev with an HTML file, image, or running app.'],
      ['Leave an annotation', 'Select an element or region and describe your change.'],
      ['Move to a fix or Issue', 'Ask AI for a fix, or review a draft and create an Issue.'],
    ], terminal: 'Review a running local app', terminalNote: 'See the quick start for installation and requirements.', quick: 'Read the quick start',
    extend: 'MAKE IT YOURS', extendTitle: 'Adapt it to the way your team works.', extendText: 'Compose review, AI, and storage with plugins. Explore the developer guide to learn how to add your own capabilities.', dev: 'Developer guide', end: 'Start your next review on screen.', endText: 'All you need to begin is a local page.',
  },
  zh: {
    badge: '本地优先的可视化审阅', title: '让「这里需要修改」', accent: '成为下一步行动。',
    lead: '在页面上添加批注，让 AI 协助修改，或创建 GitHub Issue。从反馈到改进，在熟悉的开发环境中一气呵成。', start: '快速开始', source: '在 GitHub 上查看', note: '开源 · Node.js 20+ · v1.0.0-beta.2',
    preview: '审阅工作流示意图', mode: '可视化审阅', target: '本地应用', page: '让下一个创意，在这里成形。', pageSub: '为团队打造的全新工作空间。', button: '免费开始', comment: '让这个按钮更醒目一些。', selected: '选择元素', annotation: '批注 #01', status: '审阅中', agent: '请求 AI 修改', issue: '创建 GitHub Issue', ready: '将反馈转化为实现',
    targets: '支持多种审阅对象', formats: ['静态 HTML', '图片与截图', 'localhost 应用', 'HTTPS 预发布网站'],
    eyebrow: '减少阻力，让反馈更清晰', heading: '指出问题，修改，共享。', description: '减少模糊描述和工具切换，以页面为共同上下文，持续推动改进。',
    features: [
      { icon: '01', title: '精确定位每一条反馈', text: '选择 DOM 节点或矩形区域并添加批注。在桌面、平板和手机视图间切换，准确指出需要修改的位置。', tag: '可视化批注' },
      { icon: '02', title: '继续使用熟悉的 AI 工具', text: '支持 Claude、Codex、OpenCode、GitHub Copilot、Pi 和自定义 CLI。将审阅意见转化为 coding agent 辅助修改。', tag: 'AI 辅助修改' },
      { icon: '03', title: '让每条反馈都有后续', text: '通过讨论串、状态和历史跟踪进展。确认并编辑 AI 生成的 Issue 草稿，然后分享到 GitHub。', tag: '历史与 Issue' },
    ],
    flowLabel: '你的审阅循环', flowTitle: '三个步骤，一个工作流。', steps: [
      ['打开审阅对象', '指定 HTML、图片或已运行的应用，启动 vrev。'],
      ['在页面上添加批注', '选择元素或区域，记录需要修改的内容。'],
      ['修改或创建 Issue', '请求 AI 修改，或确认草稿后创建 Issue。'],
    ], terminal: '审阅运行中的本地应用', terminalNote: '安装方法和环境要求请参阅快速入门。', quick: '阅读快速入门',
    extend: '按需扩展', extendTitle: '适应团队自己的工作方式。', extendText: '通过插件组合审阅、AI 和存储功能。在开发者指南中了解如何添加自定义能力。', dev: '开发者指南', end: '下一次审阅，从页面开始。', endText: '先打开一个本地页面，试试看。',
  },
}
const t = computed(() => copy[locale.value])
</script>

<template>
  <main class="landing">
    <section class="landing-hero" aria-labelledby="hero-title">
      <div class="hero-copy">
        <p class="eyebrow"><span class="status-dot" />{{ t.badge }}</p>
        <h1 id="hero-title">{{ t.title }}<br><span>{{ t.accent }}</span></h1>
        <p class="hero-lead">{{ t.lead }}</p>
        <div class="hero-actions">
          <a class="action primary" :href="link('getting-started')">{{ t.start }} <span aria-hidden="true">↗</span></a>
          <a class="action secondary" href="https://github.com/NAKAK10/vrev">{{ t.source }} <span aria-hidden="true">↗</span></a>
        </div>
        <p class="hero-note">{{ t.note }}</p>
      </div>
      <figure class="review-figure" :aria-label="t.preview">
        <div class="review-window">
          <div class="window-bar"><span class="window-dots" aria-hidden="true">● ● ●</span><span>vrev / {{ t.mode }}</span><span class="live-dot" aria-hidden="true" /></div>
          <div class="preview-toolbar"><span>↖ &nbsp; {{ t.selected }}</span><span>{{ t.target }} <span aria-hidden="true">↗</span></span></div>
          <div class="sample-page">
            <div class="sample-nav"><strong>acme<span>®</span></strong><div aria-hidden="true"><i /><i /><i /></div></div>
            <div class="sample-content"><span class="sample-label">WORK BETTER, TOGETHER</span><h2>{{ t.page }}</h2><p>{{ t.pageSub }}</p><span class="selection-box">{{ t.button }}<b>1</b></span></div>
            <div class="sample-tiles" aria-hidden="true"><div /><div /><div /></div>
          </div>
          <div class="annotation-card"><div class="annotation-heading"><span class="annotation-number">1</span><strong>{{ t.annotation }}</strong><span class="review-status">{{ t.status }}</span></div><p>{{ t.comment }}</p><div class="mock-actions"><span>{{ t.agent }} <span aria-hidden="true">↗</span></span><span>{{ t.issue }}</span></div></div>
          <div class="preview-footer"><span aria-hidden="true">✓</span> {{ t.ready }}</div>
        </div>
        <figcaption>{{ t.preview }}</figcaption>
      </figure>
    </section>
    <section class="target-strip" :aria-label="t.targets"><p>{{ t.targets }}</p><ul><li v-for="format in t.formats" :key="format"><span aria-hidden="true">◇</span>{{ format }}</li></ul></section>
    <section class="feature-section" aria-labelledby="features-title"><p class="eyebrow">{{ t.eyebrow }}</p><h2 id="features-title">{{ t.heading }}</h2><p class="section-lead">{{ t.description }}</p><div class="feature-grid"><article v-for="feature in t.features" :key="feature.icon" class="feature-card"><span class="feature-number">{{ feature.icon }}</span><p class="feature-tag">{{ feature.tag }}</p><h3>{{ feature.title }}</h3><p>{{ feature.text }}</p></article></div></section>
    <section class="workflow-section" aria-labelledby="workflow-title"><div><p class="eyebrow">{{ t.flowLabel }}</p><h2 id="workflow-title">{{ t.flowTitle }}</h2><ol class="workflow-steps"><li v-for="(step, index) in t.steps" :key="index"><span>{{ index + 1 }}</span><div><h3>{{ step[0] }}</h3><p>{{ step[1] }}</p></div></li></ol></div><div class="terminal-panel"><div class="terminal-title"><span aria-hidden="true">⌘</span> {{ t.terminal }}</div><pre><code><span class="terminal-comment"># localhost → vrev</span>
npx @vrev/cli serve \
  --target http://127.0.0.1:5173</code></pre><p>{{ t.terminalNote }}</p><a :href="link('getting-started')">{{ t.quick }} <span aria-hidden="true">→</span></a></div></section>
    <section class="extend-section"><div><p class="eyebrow">{{ t.extend }}</p><h2>{{ t.extendTitle }}</h2><p>{{ t.extendText }}</p><a class="text-link" :href="link('developers')">{{ t.dev }} <span aria-hidden="true">→</span></a></div><div class="plugin-stack" aria-hidden="true"><span>@vrev/review</span><span>@vrev/ai</span><span>@vrev/page-map</span><span>@vrev/github-issue</span><span>@vrev/annotation-workflow</span><span>@vrev/storage-firestore</span></div></section>
    <section class="final-cta"><h2>{{ t.end }}</h2><p>{{ t.endText }}</p><a class="action primary" :href="link('getting-started')">{{ t.start }} <span aria-hidden="true">→</span></a></section>
  </main>
</template>
