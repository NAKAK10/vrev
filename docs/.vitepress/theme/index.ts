import { h } from 'vue'
import DefaultTheme from 'vitepress/theme'
import LandingPage from './LandingPage.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, {
    'home-hero-before': () => h(LandingPage),
  }),
}
